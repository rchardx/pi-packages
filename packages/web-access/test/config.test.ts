import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig, resolveCapabilityTarget } from "../src/config.ts";

test("both hosted tools require independent provider authorization tables", () => {
  assert.deepEqual(parseConfig({}), {});
  for (const value of [
    { search: { providers: { deepseek: {} } } },
    { fetch: { providers: { deepseek: {} }, defaultProvider: "deepseek" } },
    {
      search: {
        providers: { deepseek: {} },
        defaultProvider: "deepseek",
      },
      fetch: {
        providers: { deepseek: {} },
      },
    },
  ]) {
    assert.deepEqual(parseConfig(value), value);
  }
});

for (const value of [null, [], true, "text", { unknown: true }]) {
  test(`rejects malformed top-level configuration ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseConfig(value));
  });
}

for (const key of ["search", "fetch"] as const) {
  for (const [setting, pattern] of [
    [null, new RegExp(`${key} must be an object`, "u")],
    [false, new RegExp(`${key} must be an object`, "u")],
    [[], new RegExp(`${key} must be an object`, "u")],
    [{}, new RegExp(`${key}\\.providers must be`, "u")],
    [{ provider: "deepseek" }, new RegExp(`Unknown field in ${key}`, "u")],
    [{ providers: {} }, new RegExp(`${key}\\.providers must enable at least one`, "u")],
    [{ providers: [] }, new RegExp(`${key}\\.providers must be`, "u")],
    [{ providers: { auto: {} } }, /Unsupported .* provider "auto"/u],
    [
      { providers: { anthropic: {} } },
      /Unsupported .* provider "anthropic"; supported providers are deepseek\./u,
    ],
    [
      { providers: { openai: {} } },
      /Unsupported .* provider "openai"; supported providers are deepseek\./u,
    ],
    [
      { providers: { "openai-codex": {} } },
      /Unsupported .* provider "openai-codex"; supported providers are deepseek\./u,
    ],
    [
      { providers: { google: {} } },
      /Unsupported .* provider "google"; supported providers are deepseek\./u,
    ],
    [{ providers: { deepseek: null } }, /providers\.deepseek must be a JSON object/u],
    [{ providers: { deepseek: { model: "deepseek-chat" } } }, /providers\.deepseek must be \{\}/u],
    [{ providers: { deepseek: { apiKey: "secret" } } }, /providers\.deepseek must be \{\}/u],
    [
      { providers: { deepseek: {} }, defaultProvider: "invalid" },
      /defaultProvider must be one of the supported providers \(deepseek\)/u,
    ],
  ] as const) {
    test(`rejects invalid ${key} setting ${JSON.stringify(setting)}`, () => {
      assert.throws(() => parseConfig({ [key]: setting }), pattern);
    });
  }
}

test("resolves the enabled DeepSeek provider with or without optional defaultProvider", () => {
  assert.throws(() => resolveCapabilityTarget("search", undefined), /Search is disabled/u);
  assert.throws(() => resolveCapabilityTarget("fetch", undefined), /Fetch is disabled/u);

  const single = parseConfig({ search: { providers: { deepseek: {} } } }).search;
  assert.deepEqual(resolveCapabilityTarget("search", single), { provider: "deepseek" });

  const explicit = parseConfig({
    fetch: { providers: { deepseek: {} }, defaultProvider: "deepseek" },
  }).fetch;
  assert.deepEqual(resolveCapabilityTarget("fetch", explicit), { provider: "deepseek" });
});

test("missing configuration disables both tools; invalid files fail without being rewritten", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "web-access.json");
  assert.deepEqual(await loadConfig(path), {});
  const enabled = {
    fetch: { providers: { deepseek: {} }, defaultProvider: "deepseek" as const },
  };
  await writeFile(path, JSON.stringify(enabled));
  assert.deepEqual(await loadConfig(path), enabled);
  for (const source of [
    "{",
    '{"fetch":false}',
    '{"fetch":{"provider":"deepseek"}}',
    '{"unknown":true}',
  ]) {
    await writeFile(path, source);
    await assert.rejects(loadConfig(path), /Invalid web access configuration/u);
    assert.equal(await readFile(path, "utf8"), source);
  }
  await assert.rejects(loadConfig(directory), /Cannot read web access configuration/u);
});
