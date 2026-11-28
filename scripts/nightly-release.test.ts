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
const existingTagSha = "c".repeat(40);
const createdTagSha = "d".repeat(40);
const apiBase = "https://api.github.com/repos/example/packages";
const uploadBase = "https://uploads.github.com/repos/example/packages";
const mainUrl = `${apiBase}/git/ref/heads/main`;
const refUrl = `${apiBase}/git/ref/tags/nightly`;
const refsUrl = `${apiBase}/git/refs/tags/nightly`;
const tagsUrl = `${apiBase}/git/tags`;
const existingTagUrl = `${tagsUrl}/${existingTagSha}`;
const releasesUrl = `${apiBase}/releases?per_page=100`;
const existingReleaseUrl = `${apiBase}/releases/12`;
const stagedDraftUrl = `${apiBase}/releases/13`;
const staleDraftUrl = `${apiBase}/releases/90`;
const names = ["ask", "background"];
const filenames = names.map((name) => `pi-${name}-nightly.tgz`);
const publicRelease = {
  id: 12,
  tag_name: "nightly",
  draft: false,
  prerelease: true,
  body: `| @rchardx/pi-ask | 1.0.0-nightly.41.g${oldSha} |`,
};
const draftRelease = { ...publicRelease, draft: true };
const stagedDraft = { id: 13, tag_name: "nightly-draft-987-1", draft: true, prerelease: true };
const staleDraft = { id: 90, tag_name: "nightly-draft-900-1", draft: true, prerelease: true };
const commitRefBody = (value = sha) => ({ object: { type: "commit", sha: value } });
const annotatedRefBody = (value = existingTagSha) => ({ object: { type: "tag", sha: value } });
const tagObjectBody = (value = sha) => ({ object: { type: "commit", sha: value } });

const mainRef = { ref: "refs/heads/main", ...commitRefBody() };
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
      devDependencies: { "@earendil-works/pi-coding-agent": "1.7.0" },
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
    GITHUB_RUN_ATTEMPT: "1",
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
    name: "unchanged public prerelease with annotated tag skips",
    steps: [
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      { method: "GET", url: existingTagUrl, response: tagObjectBody(sha) },
    ],
    release: publicRelease,
    force: "false",
    expected: false,
  },
  {
    name: "force rebuilds unchanged release",
    steps: [
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      { method: "GET", url: existingTagUrl, response: tagObjectBody(sha) },
    ],
    release: publicRelease,
    force: "true",
    expected: true,
  },
  {
    name: "changed commit rebuilds",
    steps: [
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      { method: "GET", url: existingTagUrl, response: tagObjectBody(oldSha) },
    ],
    release: publicRelease,
    force: "false",
    expected: true,
  },
  {
    name: "lightweight tag at selected SHA repairs to annotated tag",
    steps: [{ method: "GET", url: refUrl, response: commitRefBody(sha) }],
    release: publicRelease,
    force: "false",
    expected: true,
  },
  {
    name: "missing tag repairs",
    steps: [{ method: "GET", url: refUrl, status: 404 }],
    release: publicRelease,
    force: "false",
    expected: true,
  },
  {
    name: "missing release repairs",
    steps: [
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      { method: "GET", url: existingTagUrl, response: tagObjectBody(sha) },
    ],
    release: undefined,
    force: "false",
    expected: true,
  },
  {
    name: "draft repairs even at selected SHA",
    steps: [
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      { method: "GET", url: existingTagUrl, response: tagObjectBody(sha) },
    ],
    release: draftRelease,
    force: "false",
    expected: true,
  },
  {
    name: "non-prerelease repairs",
    steps: [
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      { method: "GET", url: existingTagUrl, response: tagObjectBody(sha) },
    ],
    release: { ...publicRelease, prerelease: false },
    force: "false",
    expected: true,
  },
]) {
  test(`nightly plan: ${scenario.name}`, async () => {
    const f = fixture();
    try {
      const mock = fakeFetch([
        ...scenario.steps,
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

test("nightly plan fails on API errors or malformed SHAs without writing output", async () => {
  const f = fixture();
  try {
    for (const [steps, pattern] of [
      [[{ method: "GET", url: refUrl, status: 500, response: { message: "boom" } }], /HTTP 500/u],
      [[{ method: "GET", url: refUrl, response: commitRefBody("bad") }], /tag ref SHA/u],
      [
        [
          { method: "GET", url: refUrl, response: annotatedRefBody() },
          { method: "GET", url: existingTagUrl, response: tagObjectBody("bad") },
        ],
        /tag target SHA/u,
      ],
    ] as const) {
      const mock = fakeFetch([...steps]);
      await assert.rejects(runNightly(["plan"], f.env, f.root, mock.fetchImpl), pattern);
      assert.equal(readFileSync(f.output, "utf8"), "existing=value\n");
      mock.done();
    }
  } finally {
    f.cleanup();
  }
});

function createTagStep(onDate?: (date: string) => void): Step {
  return {
    method: "POST",
    url: tagsUrl,
    status: 201,
    response: { sha: createdTagSha },
    check: (init) => {
      const parsed = JSON.parse(String(init?.body));
      assert.equal(parsed.tag, "nightly");
      assert.equal(parsed.message, `Nightly (${sha})`);
      assert.equal(parsed.object, sha);
      assert.equal(parsed.type, "commit");
      assert.equal(parsed.tagger.name, "github-actions[bot]");
      assert.equal(parsed.tagger.email, "41898282+github-actions[bot]@users.noreply.github.com");
      assert.match(parsed.tagger.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
      onDate?.(parsed.tagger.date);
    },
  };
}

function uploadSteps(releaseId: number): Step[] {
  return filenames.map((name) => ({
    method: "POST",
    url: `${uploadBase}/releases/${releaseId}/assets?name=${name}`,
    status: 201,
    check: (init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["Content-Type"], "application/gzip");
      assert.ok(init?.body instanceof Uint8Array);
    },
  }));
}

function checkReleaseBody(body: string, expectedDate: string): void {
  assert.ok(body.includes(`Updated: ${expectedDate}`));
  assert.ok(body.includes(`| @rchardx/pi-ask | 1.0.0-nightly.42.g${sha} |`));
  assert.ok(body.includes(`| @rchardx/pi-background | 1.1.0-nightly.42.g${sha} |`));
  assert.ok(body.includes(">=22.19.0"));
  assert.ok(body.includes("tested Pi: `1.7.0`"));
}

test("existing release stages temporary draft, cuts over release and annotated tag, and sweeps stale drafts", async () => {
  const f = fixture();
  try {
    let tagDate = "";
    const mock = fakeFetch([
      currentMain,
      {
        method: "GET",
        url: releasesUrl,
        response: [
          publicRelease,
          staleDraft,
          { id: 91, tag_name: "v1.0.0", draft: true, prerelease: false },
          { id: 92, tag_name: "nightly-draft-901-1", draft: false, prerelease: true },
        ],
      },
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      createTagStep((date) => {
        tagDate = date;
      }),
      {
        method: "POST",
        url: `${apiBase}/releases`,
        status: 201,
        response: stagedDraft,
        check: (init) => {
          const parsed = JSON.parse(String(init?.body));
          assert.equal(parsed.tag_name, "nightly-draft-987-1");
          assert.equal(parsed.target_commitish, sha);
          assert.equal(parsed.name, "Nightly");
          assert.equal(parsed.draft, true);
          assert.equal(parsed.prerelease, true);
          assert.equal(parsed.make_latest, "false");
          checkReleaseBody(parsed.body, tagDate);
        },
      },
      ...uploadSteps(13),
      currentMain,
      { method: "DELETE", url: existingReleaseUrl, status: 204 },
      {
        method: "PATCH",
        url: refsUrl,
        check: (init) =>
          assert.deepEqual(JSON.parse(String(init?.body)), { sha: createdTagSha, force: true }),
      },
      {
        method: "PATCH",
        url: stagedDraftUrl,
        check: (init) =>
          assert.deepEqual(JSON.parse(String(init?.body)), {
            tag_name: "nightly",
            target_commitish: sha,
            draft: false,
            prerelease: true,
            make_latest: "false",
          }),
      },
      { method: "DELETE", url: staleDraftUrl, status: 204 },
    ]);
    await runNightly(["publish", f.archives], f.env, f.root, mock.fetchImpl);
    mock.done();
  } finally {
    f.cleanup();
  }
});

test("existing lightweight tag migrates to annotated tag and replaces same-attempt leftover draft", async () => {
  const f = fixture();
  try {
    const mock = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [publicRelease, stagedDraft] },
      { method: "GET", url: refUrl, response: commitRefBody(oldSha) },
      { method: "DELETE", url: stagedDraftUrl, status: 204 },
      createTagStep(),
      { method: "POST", url: `${apiBase}/releases`, status: 201, response: stagedDraft },
      ...uploadSteps(13),
      currentMain,
      { method: "DELETE", url: existingReleaseUrl, status: 204 },
      {
        method: "PATCH",
        url: refsUrl,
        check: (init) =>
          assert.deepEqual(JSON.parse(String(init?.body)), { sha: createdTagSha, force: true }),
      },
      {
        method: "PATCH",
        url: stagedDraftUrl,
        check: (init) =>
          assert.deepEqual(JSON.parse(String(init?.body)), {
            tag_name: "nightly",
            target_commitish: sha,
            draft: false,
            prerelease: true,
            make_latest: "false",
          }),
      },
    ]);
    await runNightly(["publish", f.archives], f.env, f.root, mock.fetchImpl);
    mock.done();
  } finally {
    f.cleanup();
  }
});

test("first run stages temporary draft, creates annotated tag ref, and promotes draft", async () => {
  const f = fixture();
  try {
    const mock = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [] },
      { method: "GET", url: refUrl, status: 404 },
      createTagStep(),
      { method: "POST", url: `${apiBase}/releases`, status: 201, response: stagedDraft },
      ...uploadSteps(13),
      currentMain,
      {
        method: "POST",
        url: `${apiBase}/git/refs`,
        status: 201,
        check: (init) =>
          assert.deepEqual(JSON.parse(String(init?.body)), {
            ref: "refs/tags/nightly",
            sha: createdTagSha,
          }),
      },
      {
        method: "PATCH",
        url: stagedDraftUrl,
        check: (init) =>
          assert.deepEqual(JSON.parse(String(init?.body)), {
            tag_name: "nightly",
            target_commitish: sha,
            draft: false,
            prerelease: true,
            make_latest: "false",
          }),
      },
    ]);
    await runNightly(["publish", f.archives], f.env, f.root, mock.fetchImpl);
    mock.done();
  } finally {
    f.cleanup();
  }
});

test("superseded run_number for the same SHA skips without mutation, while same-run retry proceeds", async () => {
  const f = fixture();
  try {
    const sameShaRelease = {
      ...publicRelease,
      body: `| @rchardx/pi-ask | 1.0.0-nightly.42.g${sha} |\n| @rchardx/pi-background | 1.1.0-nightly.42.g${sha} |`,
    };
    const superseded = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [sameShaRelease] },
    ]);
    await runNightly(
      ["publish", f.archives],
      { ...f.env, GITHUB_RUN_NUMBER: "41" },
      f.root,
      superseded.fetchImpl,
    );
    superseded.done();

    const sameRunRetry = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [sameShaRelease] },
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      createTagStep(),
      {
        method: "POST",
        url: `${apiBase}/releases`,
        status: 201,
        response: { ...stagedDraft, tag_name: "nightly-draft-987-2" },
        check: (init) =>
          assert.equal(JSON.parse(String(init?.body)).tag_name, "nightly-draft-987-2"),
      },
      ...uploadSteps(13),
      currentMain,
      { method: "DELETE", url: existingReleaseUrl, status: 204 },
      { method: "PATCH", url: refsUrl },
      { method: "PATCH", url: stagedDraftUrl },
    ]);
    await runNightly(
      ["publish", f.archives],
      { ...f.env, GITHUB_RUN_NUMBER: "42", GITHUB_RUN_ATTEMPT: "2" },
      f.root,
      sameRunRetry.fetchImpl,
    );
    sameRunRetry.done();
  } finally {
    f.cleanup();
  }
});

test("stale publish skips before staging or when main advances during upload", async () => {
  const f = fixture();
  try {
    const staleAtStart = fakeFetch([
      { ...currentMain, response: { ...mainRef, ...commitRefBody(oldSha) } },
    ]);
    await runNightly(
      ["publish", f.archives],
      { ...f.env, NIGHTLY_FORCE: "true" },
      f.root,
      staleAtStart.fetchImpl,
    );
    staleAtStart.done();

    const advancedDuringUpload = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [publicRelease] },
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      createTagStep(),
      { method: "POST", url: `${apiBase}/releases`, status: 201, response: stagedDraft },
      ...uploadSteps(13),
      { ...currentMain, response: { ...mainRef, ...commitRefBody(oldSha) } },
      { method: "DELETE", url: stagedDraftUrl, status: 204 },
    ]);
    await runNightly(
      ["publish", f.archives],
      { ...f.env, NIGHTLY_FORCE: "true" },
      f.root,
      advancedDuringUpload.fetchImpl,
    );
    advancedDuringUpload.done();
  } finally {
    f.cleanup();
  }
});

test("failed or malformed main ref lookup aborts without mutation", async () => {
  const f = fixture();
  try {
    for (const [step, error] of [
      [{ ...currentMain, status: 404 }, /HTTP 404/u],
      [{ ...currentMain, response: { ...mainRef, ...commitRefBody("bad") } }, /main ref/u],
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

test("upload failure keeps live release and tag untouched and cleans up temporary draft", async () => {
  const f = fixture();
  try {
    const failedUpload = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [publicRelease] },
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      createTagStep(),
      { method: "POST", url: `${apiBase}/releases`, status: 201, response: stagedDraft },
      { method: "POST", url: `${uploadBase}/releases/13/assets?name=${filenames[0]}`, status: 502 },
      { method: "DELETE", url: stagedDraftUrl, status: 204 },
    ]);
    await assert.rejects(
      runNightly(["publish", f.archives], f.env, f.root, failedUpload.fetchImpl),
      /force=true.*HTTP 502/u,
    );
    failedUpload.done();

    const failedPromotion = fakeFetch([
      currentMain,
      { method: "GET", url: releasesUrl, response: [publicRelease] },
      { method: "GET", url: refUrl, response: annotatedRefBody() },
      createTagStep(),
      { method: "POST", url: `${apiBase}/releases`, status: 201, response: stagedDraft },
      ...uploadSteps(13),
      currentMain,
      { method: "DELETE", url: existingReleaseUrl, status: 204 },
      { method: "PATCH", url: refsUrl },
      { method: "PATCH", url: stagedDraftUrl, status: 502 },
    ]);
    await assert.rejects(
      runNightly(["publish", f.archives], f.env, f.root, failedPromotion.fetchImpl),
      /force=true.*HTTP 502/u,
    );
    failedPromotion.done();
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
      ["GITHUB_RUN_ATTEMPT", "0"],
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
