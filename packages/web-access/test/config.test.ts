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
    { fetch: { providers: { anthropic: {} }, defaultProvider: "anthropic" } },
    {
      search: {
        providers: { deepseek: {}, anthropic: { model: "org/claude-haiku-4-5" } },
        defaultProvider: "deepseek",
      },
      fetch: {
        providers: { deepseek: {}, anthropic: {} },
        defaultProvider: "anthropic",
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
    [{ providers: { openai: {} } }, /Unsupported .* provider "openai"/u],
    [{ providers: { deepseek: null } }, /providers\.deepseek must be a JSON object/u],
    [{ providers: { deepseek: { model: "deepseek-chat" } } }, /providers\.deepseek must be \{\}/u],
    [{ providers: { deepseek: { apiKey: "secret" } } }, /providers\.deepseek must be \{\}/u],
    [{ providers: { anthropic: { apiKey: "secret" } } }, /only model is supported/u],
    [{ providers: { anthropic: { model: "" } } }, /non-empty model ID/u],
    [{ providers: { anthropic: { model: " claude-haiku-5-5 " } } }, /non-empty model ID/u],
    [{ providers: { anthropic: { model: "claude haiku" } } }, /non-empty model ID/u],
    [{ providers: { anthropic: { model: "claude\nhaiku" } } }, /non-empty model ID/u],
    [{ providers: { anthropic: { model: 42 } } }, /non-empty model ID/u],
    [
      { providers: { deepseek: {} }, defaultProvider: "anthropic" },
      /defaultProvider "anthropic" must also be enabled/u,
    ],
    [
      { providers: { deepseek: {} }, defaultProvider: "invalid" },
      /defaultProvider must be one of/u,
    ],
  ] as const) {
    test(`rejects invalid ${key} setting ${JSON.stringify(setting)}`, () => {
      assert.throws(() => parseConfig({ [key]: setting }), pattern);
    });
  }
}

test("resolves the active model provider when enabled, otherwise defaultProvider, with no fallback", () => {
  assert.throws(
    () => resolveCapabilityTarget("search", undefined, "deepseek"),
    /Search is disabled/u,
  );
  assert.throws(
    () => resolveCapabilityTarget("fetch", undefined, "anthropic"),
    /Fetch is disabled/u,
  );

  const dual = parseConfig({
    search: {
      providers: {
        deepseek: {},
        anthropic: { model: "claude-sonnet-5-5" },
      },
      defaultProvider: "deepseek",
    },
  }).search;

  assert.deepEqual(resolveCapabilityTarget("search", dual, "anthropic"), {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  });
  assert.deepEqual(resolveCapabilityTarget("search", dual, "deepseek"), {
    provider: "deepseek",
  });
  assert.deepEqual(resolveCapabilityTarget("search", dual, "openai"), {
    provider: "deepseek",
  });
  assert.deepEqual(resolveCapabilityTarget("search", dual, undefined), {
    provider: "deepseek",
  });

  const activeOnly = parseConfig({
    fetch: {
      providers: { anthropic: {} },
    },
  }).fetch;

  assert.deepEqual(resolveCapabilityTarget("fetch", activeOnly, "anthropic"), {
    provider: "anthropic",
  });
  assert.throws(
    () => resolveCapabilityTarget("fetch", activeOnly, "openai"),
    /Active model provider "openai" is not enabled in fetch\.providers/u,
  );
  assert.throws(
    () => resolveCapabilityTarget("fetch", activeOnly, undefined),
    /No active model is selected to match fetch\.providers/u,
  );
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
