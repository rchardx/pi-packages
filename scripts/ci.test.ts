import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const script = workflow.match(/node --input-type=module <<'JS'\n([\s\S]+?)\n +JS/u)?.[1];
assert.ok(script, "CI must expose its dependency-free minimum-version reader");

function resolveMinimum(t: TestContext, manifest: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "pi-ci-minimum-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: directory,
    input: script,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output },
    timeout: 5_000,
  });
  assert.ifError(result.error);
  return { ...result, output: readFileSync(output, "utf8") };
}

test("CI derives an exact minimum from engines rather than selecting the latest match", (t) => {
  for (const version of ["22.19.0", "24.1.2"]) {
    const result = resolveMinimum(t, { engines: { node: `>=${version}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, `version=${version}\n`);
  }
});

test("CI can read the repository's declared runtime floor", (t) => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const result = resolveMinimum(t, manifest);
  assert.equal(result.status, 0, result.stderr);
  const version = result.output.trim().replace("version=", "");
  assert.equal(`>=${version}`, manifest.engines.node);
});

test("CI rejects missing, floating and compound floors instead of testing the wrong Node", (t) => {
  for (const node of [undefined, "*", "22", ">=22", "^22.19.0", ">=22.19.0 <27"]) {
    const result = resolveMinimum(t, { engines: { node } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /engines\.node must be a single >=x\.y\.z floor/u);
    assert.equal(result.output, "");
  }
  assert.notEqual(resolveMinimum(t, {}).status, 0);
});
