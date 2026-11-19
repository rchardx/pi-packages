import { appendFileSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assetName, loadPackages, nightlyVersion } from "./nightly-pack.ts";

const REQUEST_TIMEOUT_MS = 120_000;
const GITHUB_ORIGIN = "https://github.com";
const API_ORIGIN = "https://api.github.com";
const UPLOAD_ORIGIN = "https://uploads.github.com";

interface GitHubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unexpected GitHub API object");
  }
  return value as Record<string, unknown>;
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Unexpected GitHub API ID");
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export async function runNightly(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const [command, directory] = args;
  if (
    !(
      (command === "plan" && args.length === 1) ||
      (command === "publish" && args.length === 2 && directory)
    )
  ) {
    throw new Error(
      "usage: node --experimental-strip-types scripts/nightly-release.ts plan|publish <archives-directory>",
    );
  }

  const token = required(env, "GH_TOKEN");
  const repository = required(env, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repo");
  }
  const sha = required(env, "NIGHTLY_SHA");
  const runNumber = required(env, "GITHUB_RUN_NUMBER");
  nightlyVersion("0.0.0", runNumber, sha);
  const runId = required(env, "GITHUB_RUN_ID");
  if (!/^[1-9]\d*$/u.test(runId)) throw new Error("GITHUB_RUN_ID must be positive");
  const prefix = `repos/${repository}`;

  async function api(
    method: string,
    path: string,
    options: {
      body?: Record<string, unknown>;
      upload?: Uint8Array<ArrayBuffer>;
      allowMissing?: boolean;
      origin?: string;
    } = {},
  ): Promise<unknown> {
    const url = `${options.origin ?? API_ORIGIN}/${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    let body: BodyInit | undefined;
    if (options.upload) {
      headers["Content-Type"] = "application/gzip";
      body = options.upload;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404 && options.allowMissing) return undefined;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}: ${text.trim()}`);
    }
    return text.trim() ? JSON.parse(text) : undefined;
  }

  async function findRelease(): Promise<GitHubRelease | undefined> {
    // The tag lookup endpoint excludes drafts; authenticated listing includes them.
    const releases = await api("GET", `${prefix}/releases?per_page=100`);
    if (!Array.isArray(releases)) throw new Error("Unexpected GitHub releases response");
    for (const item of releases) {
      const release = record(item);
      if (release.tag_name === "nightly") {
        if (typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean") {
          throw new Error("Unexpected GitHub release flags");
        }
        return {
          id: positiveId(release.id),
          tag_name: "nightly",
          draft: release.draft,
          prerelease: release.prerelease,
        };
      }
    }
    return undefined;
  }

  async function readTag(): Promise<string | undefined> {
    const value = await api("GET", `${prefix}/git/ref/tags/nightly`, { allowMissing: true });
    if (value === undefined) return undefined;
    const object = record(record(value).object);
    if (object.type !== "commit" || typeof object.sha !== "string") {
      throw new Error("The nightly tag must be lightweight and point to a commit");
    }
    return object.sha;
  }

  if (command === "plan") {
    const force = required(env, "NIGHTLY_FORCE");
    if (force !== "true" && force !== "false") {
      throw new Error("NIGHTLY_FORCE must be true or false");
    }
    const output = required(env, "GITHUB_OUTPUT");
    const current = await readTag();
    const release = await findRelease();
    const publish =
      force === "true" || current !== sha || !release || release.draft || !release.prerelease;
    appendFileSync(output, `publish=${Boolean(publish)}\n`);
    return;
  }

  const packages = await loadPackages(root);
  const archives = await Promise.all(
    packages.map(async (pkg) => {
      const name = assetName(pkg.name);
      const path = resolve(root, directory ?? "", name);
      const info = statSync(path);
      if (!info.isFile() || info.size === 0) {
        throw new Error(`Archive must be a nonempty regular file: ${path}`);
      }
      return { name, bytes: new Uint8Array(await readFile(path)) };
    }),
  );

  const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const minimumNode = record(record(manifest).engines).node;
  if (typeof minimumNode !== "string") {
    throw new Error("Root package.json must declare engines.node");
  }
  const developmentNode = readFileSync(join(root, ".node-version"), "utf8").trim();
  const piVersion = record(record(manifest).devDependencies)["@earendil-works/pi-coding-agent"];
  if (typeof piVersion !== "string") {
    throw new Error("Root package.json must pin the Pi development dependency");
  }

  const body = [
    "Rolling development builds; not stable releases. Assets are replaced in place, not atomically.",
    "",
    `Commit: ${GITHUB_ORIGIN}/${repository}/commit/${sha}`,
    `Build: ${GITHUB_ORIGIN}/${repository}/actions/runs/${runId}`,
    `Updated: ${new Date().toISOString()}`,
    `Node.js minimum: \`${minimumNode}\`; development runtime: \`${developmentNode}\`; tested Pi: \`${piVersion}\`.`,
    "",
    "| Package | Version |",
    "| --- | --- |",
    ...packages.map((pkg) => `| ${pkg.name} | ${nightlyVersion(pkg.version, runNumber, sha)} |`),
    "",
    "Install downloaded archives into a fresh prefix with `npm install --prefix <fresh-prefix> --legacy-peer-deps --ignore-scripts <downloaded.tgz>`, then register each installed package directory with `pi install <fresh-prefix>/node_modules/@rchardx/pi-<name>`.",
    `See [nightly installation instructions](${GITHUB_ORIGIN}/${repository}/blob/${sha}/CONTRIBUTING.md#install-a-nightly-snapshot).`,
  ].join("\n");

  // A rerun can reach publish with archives verified for a previous main tip.
  const mainRef = record(await api("GET", `${prefix}/git/ref/heads/main`));
  const main = record(mainRef.object);
  if (
    mainRef.ref !== "refs/heads/main" ||
    main.type !== "commit" ||
    typeof main.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(main.sha)
  ) {
    throw new Error("Unexpected GitHub main ref response");
  }
  if (main.sha !== sha) {
    console.log(`Skipping stale nightly: verified ${sha}, but main now points to ${main.sha}.`);
    return;
  }

  try {
    let release = await findRelease();
    await readTag(); // Reject annotated tags before changing any remote state.
    if (!release) {
      const created = record(
        await api("POST", `${prefix}/releases`, {
          body: {
            tag_name: "nightly",
            target_commitish: sha,
            name: "Nightly",
            draft: true,
            prerelease: true,
            make_latest: "false",
          },
        }),
      );
      release = { id: positiveId(created.id), tag_name: "nightly", draft: true, prerelease: true };
    }

    const rawAssets = await api("GET", `${prefix}/releases/${release.id}/assets?per_page=100`);
    if (!Array.isArray(rawAssets)) throw new Error("Unexpected GitHub assets response");
    const existingAssets = rawAssets.map(record);

    for (const archive of archives) {
      for (const existing of existingAssets.filter((asset) => asset.name === archive.name)) {
        await api("DELETE", `${prefix}/releases/assets/${positiveId(existing.id)}`);
      }
      await api(
        "POST",
        `${prefix}/releases/${release.id}/assets?name=${encodeURIComponent(archive.name)}`,
        { origin: UPLOAD_ORIGIN, upload: archive.bytes },
      );
    }

    await api("PATCH", `${prefix}/releases/${release.id}`, {
      body: {
        name: "Nightly",
        body,
        ...(release.draft ? { draft: false } : {}),
        prerelease: true,
        make_latest: "false",
        target_commitish: sha,
      },
    });

    // Re-read because publishing a draft can create the tag itself.
    if ((await readTag()) === undefined) {
      await api("POST", `${prefix}/git/refs`, { body: { ref: "refs/tags/nightly", sha } });
    } else {
      await api("PATCH", `${prefix}/git/refs/tags/nightly`, { body: { sha, force: true } });
    }
  } catch (error) {
    throw new Error(
      `Nightly publication failed; assets may be partially replaced. Fix the failure and rerun with force=true to repair the same release. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNightly(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
