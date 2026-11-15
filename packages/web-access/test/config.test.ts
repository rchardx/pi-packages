import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig } from "../src/config.ts";

test("both hosted tools require independent opt-in", () => {
  assert.deepEqual(parseConfig({}), {});
  for (const value of [
    { search: { provider: "deepseek" } },
    { fetch: { provider: "deepseek" } },
    { search: { provider: "deepseek" }, fetch: { provider: "deepseek" } },
  ])
    assert.deepEqual(parseConfig(value), value);
});

for (const value of [null, [], true, "text", { unknown: true }]) {
  test(`rejects malformed configuration ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseConfig(value));
  });
}

for (const key of ["search", "fetch"]) {
  for (const setting of [
    null,
    false,
    [],
    {},
    { provider: "auto" },
    { provider: "deepseek", apiKey: "not-allowed" },
  ]) {
    test(`rejects invalid ${key} setting ${JSON.stringify(setting)}`, () => {
      assert.throws(() => parseConfig({ [key]: setting }), new RegExp(`${key} must be`, "u"));
    });
  }
}

test("missing configuration disables both tools; invalid files fail without being rewritten", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "web-access.json");
  assert.deepEqual(await loadConfig(path), {});
  const enabled = { fetch: { provider: "deepseek" } };
  await writeFile(path, JSON.stringify(enabled));
  assert.deepEqual(await loadConfig(path), enabled);
  for (const source of ["{", '{"fetch":false}', '{"unknown":true}']) {
    await writeFile(path, source);
    await assert.rejects(loadConfig(path), /Invalid web access configuration/u);
    assert.equal(await readFile(path, "utf8"), source);
  }
  await assert.rejects(loadConfig(directory), /Cannot read web access configuration/u);
});
