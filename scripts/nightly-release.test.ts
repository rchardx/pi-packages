import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runNightly } from "./nightly-release.ts";

const sha = "a".repeat(40);
const oldSha = "b".repeat(40);
const apiBase = "https://api.github.com/repos/example/packages";
const uploadBase = "https://uploads.github.com/repos/example/packages";
const mainUrl = `${apiBase}/git/ref/heads/main`;
const refUrl = `${apiBase}/git/ref/tags/nightly`;
const refsUrl = `${apiBase}/git/refs/tags/nightly`;
const releasesUrl = `${apiBase}/releases?per_page=100`;
const releaseUrl = `${apiBase}/releases/12`;
const assetsUrl = `${releaseUrl}/assets?per_page=100`;
const names = ["ask", "background"];
const filenames = names.map((name) => `pi-${name}-nightly.tgz`);
const publicRelease = { id: 12, tag_name: "nightly", draft: false, prerelease: true };
const draftRelease = { ...publicRelease, draft: true };
const tagBody = (value = sha) => ({ object: { type: "commit", sha: value } });

const mainRef = { ref: "refs/heads/main", ...tagBody() };
const currentMain = { method: "GET", url: mainUrl, response: mainRef };

interface Step {
  method: string;
  url: string;
  status?: number;
  response?: unknown;
  check?: (init: RequestInit | undefined) => void;
}

function fakeFetch(steps: Step[]) {
  let index = 0;
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const step = steps[index++];
    assert.ok(step, `Unexpected ${method} ${url}`);
    assert.equal(method, step.method);
    assert.equal(url, step.url);
    step.check?.(init);
    const status = step.status ?? 200;
    const payload = step.response === undefined ? null : JSON.stringify(step.response);
    return new Response(payload, { status });
  }) as typeof fetch;
  return { fetchImpl, calls, done: () => assert.equal(index, steps.length) };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-nightly-release-"));
  const archives = join(root, "archives");
  mkdirSync(archives);
  for (const [index, name] of names.entries()) {
    const directory = join(root, "packages", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: `@rchardx/pi-${name}`, version: `1.${index}.0`, private: true }),
    );
    writeFileSync(join(archives, `pi-${name}-nightly.tgz`), `archive-${name}`);
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      engines: { node: ">=22.19.0" },
      devDependencies: { "@earendil-works/pi-coding-agent": "1.5.2" },
    }),
  );
  writeFileSync(join(root, ".node-version"), "26.13.0\n");
  const output = join(root, "output");
  writeFileSync(output, "existing=value\n");
  const env: NodeJS.ProcessEnv = {
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "example/packages",
    NIGHTLY_SHA: sha,
    GITHUB_RUN_NUMBER: "42",
    GITHUB_RUN_ID: "987",
    NIGHTLY_FORCE: "false",
    GITHUB_OUTPUT: output,
  };
  return {
    root,
    archives,
    env,
    output,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const scenario of [
  {
    name: "unchanged public prerelease skips",
    tag: sha,
    release: publicRelease,
    force: "false",
    expected: false,
  },
  {
    name: "force rebuilds unchanged release",
    tag: sha,
    release: publicRelease,
    force: "true",
    expected: true,
  },
  {
    name: "changed commit rebuilds",
    tag: oldSha,
    release: publicRelease,
    force: "false",
    expected: true,
  },
  {
    name: "missing tag repairs",
    tag: undefined,
    release: publicRelease,
    force: "false",
    expected: true,
  },
  { name: "missing release repairs", tag: sha, release: undefined, force: "false", expected: true },
  {
    name: "draft repairs even at selected SHA",
    tag: sha,
    release: draftRelease,
    force: "false",
    expected: true,
  },
  {
    name: "non-prerelease repairs",
    tag: sha,
    release: { ...publicRelease, prerelease: false },
    force: "false",
    expected: true,
  },
]) {
  test(`nightly plan: ${scenario.name}`, async () => {
    const f = fixture();
    try {
      const mock = fakeFetch([
        {
          method: "GET",
          url: refUrl,
          status: scenario.tag ? 200 : 404,
          response: tagBody(scenario.tag),
        },
        { method: "GET", url: releasesUrl, response: scenario.release ? [scenario.release] : [] },
      ]);
      await runNightly(
        ["plan"],
        { ...f.env, NIGHTLY_FORCE: scenario.force },
        f.root,
        mock.fetchImpl,
      );
      assert.equal(
        readFileSync(f.output, "utf8"),
        `existing=value\npublish=${scenario.expected}\n`,
      );
      mock.done();
    } finally {
      f.cleanup();
    }
  });
}

test("nightly plan fails on API errors without writing output", async () => {
  const f = fixture();
  try {
    const mock = fakeFetch([
      { method: "GET", url: refUrl, status: 500, response: { message: "boom" } },
    ]);
    await assert.rejects(runNightly(["plan"], f.env, f.root, mock.fetchImpl), /HTTP 500/u);
    assert.equal(readFileSync(f.output, "utf8"), "existing=value\n");
    mock.done();
  } finally {
    f.cleanup();
  }
});

function uploadSteps(overwrite = false): Step[] {
  return filenames.flatMap((name, index) => [
    ...(overwrite
      ? [{ method: "DELETE", url: `${apiBase}/releases/assets/${100 + index}`, status: 204 }]
      : []),
    {
      method: "POST",
      url: `${uploadBase}/releases/12/assets?name=${name}`,
      status: 201,
      check: (init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers["Content-Type"], "application/gzip");
        assert.ok(init?.body instanceof Uint8Array);
      },
    },
  ]);
}

test("existing release overwrites matching assets, updates notes, and moves tag last", async () => {
  const f = fixture();
  try {
    const mock = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [publicRelease] },
      { method: "GET", url: refUrl, response: tagBody(oldSha) },
      {
        method: "GET",
        url: assetsUrl,
        response: [
          ...filenames.map((name, index) => ({ name, id: 100 + index })),
          { name: "unrelated.txt", id: 99 },
        ],
      },
      ...uploadSteps(true),
      {
        method: "PATCH",
        url: releaseUrl,
        check: (init) => {
          const parsed = JSON.parse(String(init?.body));
          assert.equal(parsed.prerelease, true);
          assert.equal(parsed.make_latest, "false");
          assert.equal(parsed.target_commitish, sha);
          assert.ok(parsed.body.includes(`| @rchardx/pi-ask | 1.0.0-nightly.42.g${sha} |`));
          assert.ok(parsed.body.includes(`| @rchardx/pi-background | 1.1.0-nightly.42.g${sha} |`));
          assert.ok(parsed.body.includes(">=22.19.0"));
        },
      },
      { method: "GET", url: refUrl, response: tagBody(oldSha) },
      {
        method: "PATCH",
        url: refsUrl,
        check: (init) => assert.deepEqual(JSON.parse(String(init?.body)), { sha, force: true }),
      },
    ]);
    await runNightly(["publish", f.archives], f.env, f.root, mock.fetchImpl);
    mock.done();
  } finally {
    f.cleanup();
  }
});

test("first run creates draft, uploads assets, publishes, and establishes tag", async () => {
  const f = fixture();
  try {
    const mock = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [] },
      { method: "GET", url: refUrl, status: 404 },
      { method: "POST", url: `${apiBase}/releases`, status: 201, response: draftRelease },
      { method: "GET", url: assetsUrl, response: [] },
      ...uploadSteps(false),
      {
        method: "PATCH",
        url: releaseUrl,
        check: (init) => assert.equal(JSON.parse(String(init?.body)).draft, false),
      },
      { method: "GET", url: refUrl, status: 404 },
      {
        method: "POST",
        url: `${apiBase}/git/refs`,
        status: 201,
        check: (init) =>
          assert.deepEqual(JSON.parse(String(init?.body)), { ref: "refs/tags/nightly", sha }),
      },
    ]);
    await runNightly(["publish", f.archives], f.env, f.root, mock.fetchImpl);
    mock.done();
  } finally {
    f.cleanup();
  }
});

test("stale publish skips without mutation, even when forced", async () => {
  const f = fixture();
  try {
    const mock = fakeFetch([{ ...currentMain, response: { ...mainRef, ...tagBody(oldSha) } }]);
    await runNightly(
      ["publish", f.archives],
      { ...f.env, NIGHTLY_FORCE: "true" },
      f.root,
      mock.fetchImpl,
    );
    mock.done();
  } finally {
    f.cleanup();
  }
});

test("failed or malformed main ref lookup aborts without mutation", async () => {
  const f = fixture();
  try {
    for (const [step, error] of [
      [{ ...currentMain, status: 404 }, /HTTP 404/u],
      [{ ...currentMain, response: { ...mainRef, ...tagBody("bad") } }, /main ref/u],
      [{ ...currentMain, response: { ...mainRef, object: { type: "tag", sha } } }, /main ref/u],
      [{ ...currentMain, response: { ...mainRef, ref: "refs/heads/other" } }, /main ref/u],
    ] as const) {
      const mock = fakeFetch([step]);
      await assert.rejects(
        runNightly(["publish", f.archives], f.env, f.root, mock.fetchImpl),
        error,
      );
      mock.done();
    }
  } finally {
    f.cleanup();
  }
});

test("preflight rejects missing or empty archives before remote mutation", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.archives, "pi-background-nightly.tgz"), "");
    const mock = fakeFetch([]);
    await assert.rejects(
      runNightly(["publish", f.archives], f.env, f.root, mock.fetchImpl),
      /nonempty regular file/u,
    );
    mock.done();
  } finally {
    f.cleanup();
  }
});

test("annotated tag and upload failures abort before tag mutation", async () => {
  const f = fixture();
  try {
    const annotated = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [publicRelease] },
      { method: "GET", url: refUrl, response: { object: { type: "tag", sha } } },
    ]);
    await assert.rejects(
      runNightly(["publish", f.archives], f.env, f.root, annotated.fetchImpl),
      /must be lightweight/u,
    );
    annotated.done();

    const failedUpload = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [publicRelease] },
      { method: "GET", url: refUrl, response: tagBody(oldSha) },
      { method: "GET", url: assetsUrl, response: [] },
      { method: "POST", url: `${uploadBase}/releases/12/assets?name=${filenames[0]}`, status: 502 },
    ]);
    await assert.rejects(
      runNightly(["publish", f.archives], f.env, f.root, failedUpload.fetchImpl),
      /force=true.*HTTP 502/u,
    );
    failedUpload.done();
  } finally {
    f.cleanup();
  }
});

test("invalid environment and CLI usage fail before API calls", async () => {
  const f = fixture();
  try {
    for (const [key, value] of [
      ["GH_TOKEN", ""],
      ["NIGHTLY_FORCE", "yes"],
      ["NIGHTLY_SHA", "short"],
      ["GITHUB_REPOSITORY", "a/b/c"],
    ] as const) {
      const mock = fakeFetch([]);
      await assert.rejects(
        runNightly(["plan"], { ...f.env, [key]: value }, f.root, mock.fetchImpl),
      );
      mock.done();
    }
  } finally {
    f.cleanup();
  }

  const script = fileURLToPath(new URL("./nightly-release.ts", import.meta.url));
  const cli = spawnSync(process.execPath, ["--experimental-strip-types", script, "invalid"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /usage: node --experimental-strip-types/u);
});
