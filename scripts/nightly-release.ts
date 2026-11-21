import { appendFileSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assetName, loadPackages, nightlyVersion } from "./nightly-pack.ts";

const REQUEST_TIMEOUT_MS = 120_000;
const GITHUB_ORIGIN = "https://github.com";
const API_ORIGIN = "https://api.github.com";
const UPLOAD_ORIGIN = "https://uploads.github.com";
const TAGGER_NAME = "github-actions[bot]";
const TAGGER_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const DRAFT_PREFIX = "nightly-draft-";
const DRAFT_TAG = /^nightly-draft-[1-9]\d*-[1-9]\d*$/u;

interface GitHubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string;
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

function gitSha(value: unknown, message: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(message);
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
  const runAttempt = required(env, "GITHUB_RUN_ATTEMPT");
  if (!/^[1-9]\d*$/u.test(runAttempt)) throw new Error("GITHUB_RUN_ATTEMPT must be positive");
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

  async function findReleases(): Promise<{
    nightly: GitHubRelease | undefined;
    staleDrafts: GitHubRelease[];
  }> {
    // The tag lookup endpoint excludes drafts; authenticated listing includes them.
    const releases = await api("GET", `${prefix}/releases?per_page=100`);
    if (!Array.isArray(releases)) throw new Error("Unexpected GitHub releases response");
    let nightly: GitHubRelease | undefined;
    const staleDrafts: GitHubRelease[] = [];
    for (const item of releases) {
      const release = record(item);
      const tagName = release.tag_name;
      const isNightly = tagName === "nightly";
      const isStaleDraft =
        release.draft === true && typeof tagName === "string" && DRAFT_TAG.test(tagName);
      if (!isNightly && !isStaleDraft) continue;
      if (typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean") {
        throw new Error("Unexpected GitHub release flags");
      }
      if (release.body !== undefined && release.body !== null && typeof release.body !== "string") {
        throw new Error("Unexpected GitHub release body");
      }
      const parsed: GitHubRelease = {
        id: positiveId(release.id),
        tag_name: tagName,
        draft: release.draft,
        prerelease: release.prerelease,
        body: typeof release.body === "string" ? release.body : "",
      };
      if (isNightly) {
        nightly ??= parsed;
      } else {
        staleDrafts.push(parsed);
      }
    }
    return { nightly, staleDrafts };
  }

  function publishedRunForSha(
    release: GitHubRelease | undefined,
    targetSha: string,
  ): bigint | undefined {
    if (!release || release.draft || !release.prerelease) return undefined;
    const pattern = new RegExp(`-nightly\\.([1-9]\\d*)\\.g${targetSha}\\b`, "gu");
    let maxRun: bigint | undefined;
    for (const match of release.body.matchAll(pattern)) {
      const matched = match[1];
      if (!matched) continue;
      const value = BigInt(matched);
      if (maxRun === undefined || value > maxRun) maxRun = value;
    }
    return maxRun;
  }

  async function readAnnotatedCommit(): Promise<string | undefined> {
    const value = await api("GET", `${prefix}/git/ref/tags/nightly`, { allowMissing: true });
    if (value === undefined) return undefined;
    const object = record(record(value).object);
    const objectSha = gitSha(object.sha, "Unexpected GitHub tag ref SHA");
    if (object.type !== "tag") return undefined;
    const tag = record(await api("GET", `${prefix}/git/tags/${objectSha}`));
    const target = record(tag.object);
    const targetSha = gitSha(target.sha, "Unexpected GitHub tag target SHA");
    return target.type === "commit" ? targetSha : undefined;
  }

  if (command === "plan") {
    const force = required(env, "NIGHTLY_FORCE");
    if (force !== "true" && force !== "false") {
      throw new Error("NIGHTLY_FORCE must be true or false");
    }
    const output = required(env, "GITHUB_OUTPUT");
    const current = await readAnnotatedCommit();
    const { nightly: release } = await findReleases();
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

  const updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  const body = [
    "Rolling development builds; not stable releases. Replaced as a fresh prerelease on each publish; avoid downloading while a run is publishing.",
    "",
    `Commit: ${GITHUB_ORIGIN}/${repository}/commit/${sha}`,
    `Build: ${GITHUB_ORIGIN}/${repository}/actions/runs/${runId}`,
    `Updated: ${updatedAt}`,
    `Node.js minimum: \`${minimumNode}\`; development runtime: \`${developmentNode}\`; tested Pi: \`${piVersion}\`.`,
    "",
    "| Package | Version |",
    "| --- | --- |",
    ...packages.map((pkg) => `| ${pkg.name} | ${nightlyVersion(pkg.version, runNumber, sha)} |`),
    "",
    "Install downloaded archives into a fresh prefix with `npm install --prefix <fresh-prefix> --legacy-peer-deps --ignore-scripts <downloaded.tgz>`, then register each installed package directory with `pi install <fresh-prefix>/node_modules/@rchardx/pi-<name>`.",
    `See [nightly installation instructions](${GITHUB_ORIGIN}/${repository}/blob/${sha}/docs/installation.md#install-a-nightly-snapshot).`,
  ].join("\n");

  async function isCurrentMain(): Promise<boolean> {
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
      return false;
    }
    return true;
  }

  // A rerun can reach publish with archives verified for a previous main tip.
  if (!(await isCurrentMain())) return;

  const draftTag = `${DRAFT_PREFIX}${runId}-${runAttempt}`;
  let cleanupDraftId: number | undefined;

  try {
    const { nightly: existingRelease, staleDrafts } = await findReleases();
    const publishedRun = publishedRunForSha(existingRelease, sha);
    if (publishedRun !== undefined && BigInt(runNumber) < publishedRun) {
      console.log(
        `Skipping superseded nightly: run ${runNumber} predates published run ${publishedRun} for ${sha}.`,
      );
      return;
    }

    const hasTagRef =
      (await api("GET", `${prefix}/git/ref/tags/nightly`, { allowMissing: true })) !== undefined;

    for (const duplicate of staleDrafts.filter((draft) => draft.tag_name === draftTag)) {
      await api("DELETE", `${prefix}/releases/${duplicate.id}`, { allowMissing: true });
    }

    const createdTag = record(
      await api("POST", `${prefix}/git/tags`, {
        body: {
          tag: "nightly",
          message: `Nightly (${sha})`,
          object: sha,
          type: "commit",
          tagger: {
            name: TAGGER_NAME,
            email: TAGGER_EMAIL,
            date: updatedAt,
          },
        },
      }),
    );
    const tagSha = gitSha(createdTag.sha, "Unexpected GitHub tag SHA");

    const createdDraft = record(
      await api("POST", `${prefix}/releases`, {
        body: {
          tag_name: draftTag,
          target_commitish: sha,
          name: "Nightly",
          body,
          draft: true,
          prerelease: true,
          make_latest: "false",
        },
      }),
    );
    const draftId = positiveId(createdDraft.id);
    cleanupDraftId = draftId;

    for (const archive of archives) {
      await api(
        "POST",
        `${prefix}/releases/${draftId}/assets?name=${encodeURIComponent(archive.name)}`,
        { origin: UPLOAD_ORIGIN, upload: archive.bytes },
      );
    }

    if (!(await isCurrentMain())) return;

    if (existingRelease) {
      await api("DELETE", `${prefix}/releases/${existingRelease.id}`);
    }

    if (!hasTagRef) {
      await api("POST", `${prefix}/git/refs`, {
        body: { ref: "refs/tags/nightly", sha: tagSha },
      });
    } else {
      await api("PATCH", `${prefix}/git/refs/tags/nightly`, {
        body: { sha: tagSha, force: true },
      });
    }

    // Clear cleanupDraftId before promotion so a response-read failure cannot delete a newly published release.
    cleanupDraftId = undefined;
    await api("PATCH", `${prefix}/releases/${draftId}`, {
      body: {
        tag_name: "nightly",
        target_commitish: sha,
        draft: false,
        prerelease: true,
        make_latest: "false",
      },
    });

    for (const stale of staleDrafts) {
      if (stale.tag_name !== draftTag && stale.id !== draftId) {
        try {
          await api("DELETE", `${prefix}/releases/${stale.id}`, { allowMissing: true });
        } catch (cleanupError) {
          console.warn(
            `Failed to delete stale nightly draft ${stale.id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
    }
  } catch (error) {
    throw new Error(
      `Nightly publication failed before completing the replacement prerelease. Fix the failure and rerun the workflow (or dispatch with force=true) to repair it. ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (cleanupDraftId !== undefined) {
      try {
        await api("DELETE", `${prefix}/releases/${cleanupDraftId}`, { allowMissing: true });
      } catch (cleanupError) {
        console.warn(
          `Failed to clean up unpublished nightly draft ${cleanupDraftId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNightly(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
