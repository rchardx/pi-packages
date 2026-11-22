import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig, resolveFetchTarget, resolveSearchTarget } from "../src/config.ts";

test("both hosted tools accept single-provider or multi-provider authorization tables", () => {
  assert.deepEqual(parseConfig({}), {});
  for (const value of [
    { search: { providers: { exa: {} } } },
    { search: { providers: { parallel: {} } } },
    { search: { providers: { deepseek: {} } } },
    { fetch: { providers: { exa: { maxAgeHours: 24 } } } },
    { fetch: { providers: { parallel: { maxAgeHours: 0 } } } },
    {
      search: {
        providers: {
          exa: { mode: "auto", maxAgeHours: 24 },
          parallel: { mode: "fast", maxAgeHours: -1 },
          deepseek: {},
        },
        defaultProvider: "exa",
      },
      fetch: {
        providers: {
          exa: { maxAgeHours: 0 },
          parallel: { maxAgeHours: 12 },
          deepseek: {},
        },
        defaultProvider: "parallel",
      },
    },
    {
      search: {
        providers: {
          exa: { mode: "lite" },
          deepseek: {},
        },
        defaultProvider: "deepseek",
      },
      fetch: {
        providers: {
          exa: { maxAgeHours: -1 },
        },
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
    [{ provider: "exa" }, new RegExp(`Unknown field in ${key}`, "u")],
    [{ providers: {} }, new RegExp(`${key}\\.providers must enable at least one`, "u")],
    [{ providers: [] }, new RegExp(`${key}\\.providers must be`, "u")],
    [{ providers: { auto: {} } }, /Unsupported .* provider "auto"/u],
    [
      { providers: { anthropic: {} } },
      /Unsupported .* provider "anthropic"; supported providers are deepseek, exa, parallel\./u,
    ],
    [
      { providers: { openai: {} } },
      /Unsupported .* provider "openai"; supported providers are deepseek, exa, parallel\./u,
    ],
    [{ providers: { deepseek: null } }, /providers\.deepseek must be a JSON object/u],
    [{ providers: { deepseek: { mode: "auto" } } }, /providers\.deepseek must be \{\}/u],
    [{ providers: { deepseek: { apiKey: "secret" } } }, /providers\.deepseek must be \{\}/u],
    [{ providers: { exa: null } }, /providers\.exa must be a JSON object/u],
    [{ providers: { exa: { apiKey: "secret" } } }, /Unknown field in .*\.providers\.exa/u],
    [{ providers: { parallel: null } }, /providers\.parallel must be a JSON object/u],
    [
      { providers: { parallel: { apiKey: "secret" } } },
      /Unknown field in .*\.providers\.parallel/u,
    ],
    [
      { providers: { exa: { maxAgeHours: -2 } } },
      /maxAgeHours must be an integer between -1 and 720/u,
    ],
    [
      { providers: { exa: { maxAgeHours: 721 } } },
      /maxAgeHours must be an integer between -1 and 720/u,
    ],
    [
      { providers: { exa: { maxAgeHours: 1.5 } } },
      /maxAgeHours must be an integer between -1 and 720/u,
    ],
    [
      { providers: { exa: { maxAgeHours: "24" } } },
      /maxAgeHours must be an integer between -1 and 720/u,
    ],
    [
      { providers: { parallel: { maxAgeHours: 721 } } },
      /maxAgeHours must be an integer between (-1|0) and 720/u,
    ],
    [
      { providers: { deepseek: {}, exa: {} } },
      /defaultProvider is required when multiple providers are enabled/u,
    ],
    [
      { providers: { deepseek: {} }, defaultProvider: "parallel" },
      /defaultProvider "parallel" must also be enabled/u,
    ],
    [
      { providers: { exa: {} }, defaultProvider: "invalid" },
      /defaultProvider must be one of the supported providers \(deepseek, exa, parallel\)/u,
    ],
  ] as const) {
    test(`rejects invalid ${key} setting ${JSON.stringify(setting)}`, () => {
      assert.throws(() => parseConfig({ [key]: setting }), pattern);
    });
  }
}

test("validates Exa and Parallel search modes, cache constraints, and fetch-only option boundaries", () => {
  for (const mode of ["lite", "auto", "deep-lite", "deep"] as const) {
    const parsed = parseConfig({ search: { providers: { exa: { mode } } } });
    assert.deepEqual(resolveSearchTarget(parsed.search), {
      provider: "exa",
      options: { mode },
    });
  }
  for (const mode of ["turbo", "fast", "basic", "advanced"] as const) {
    const parsed = parseConfig({ search: { providers: { parallel: { mode } } } });
    assert.deepEqual(resolveSearchTarget(parsed.search), {
      provider: "parallel",
      options: { mode },
    });
  }
  assert.throws(
    () => parseConfig({ search: { providers: { exa: { mode: "fast" } } } }),
    /search\.providers\.exa\.mode must be one of lite, auto, deep-lite, deep/u,
  );
  assert.throws(
    () => parseConfig({ search: { providers: { parallel: { mode: "auto" } } } }),
    /search\.providers\.parallel\.mode must be one of turbo, fast, basic, advanced/u,
  );
  assert.throws(
    () => parseConfig({ search: { providers: { exa: { mode: "lite", maxAgeHours: 24 } } } }),
    /cannot combine mode "lite" with maxAgeHours/u,
  );
  assert.throws(
    () => parseConfig({ fetch: { providers: { exa: { mode: "auto" } } } }),
    /Unknown field in fetch\.providers\.exa: only maxAgeHours is supported/u,
  );
  assert.throws(
    () => parseConfig({ fetch: { providers: { parallel: { mode: "fast" } } } }),
    /Unknown field in fetch\.providers\.parallel: only maxAgeHours is supported/u,
  );
  assert.throws(
    () => parseConfig({ fetch: { providers: { parallel: { maxAgeHours: -1 } } } }),
    /fetch\.providers\.parallel\.maxAgeHours must be an integer between 0 and 720/u,
  );
});

test("resolves single-provider and three-provider targets deterministically", () => {
  assert.throws(() => resolveSearchTarget(undefined), /Search is disabled/u);
  assert.throws(() => resolveFetchTarget(undefined), /Fetch is disabled/u);

  const singleParallel = parseConfig({
    search: { providers: { parallel: { mode: "basic", maxAgeHours: 6 } } },
    fetch: { providers: { parallel: { maxAgeHours: 0 } } },
  });
  assert.deepEqual(resolveSearchTarget(singleParallel.search), {
    provider: "parallel",
    options: { mode: "basic", maxAgeHours: 6 },
  });
  assert.deepEqual(resolveFetchTarget(singleParallel.fetch), {
    provider: "parallel",
    options: { maxAgeHours: 0 },
  });

  for (const defaultProvider of ["exa", "parallel", "deepseek"] as const) {
    const parsed = parseConfig({
      search: {
        providers: {
          exa: { mode: "auto" },
          parallel: { mode: "fast" },
          deepseek: {},
        },
        defaultProvider,
      },
      fetch: {
        providers: {
          exa: { maxAgeHours: 24 },
          parallel: { maxAgeHours: 12 },
          deepseek: {},
        },
        defaultProvider,
      },
    });
    assert.equal(resolveSearchTarget(parsed.search).provider, defaultProvider);
    assert.equal(resolveFetchTarget(parsed.fetch).provider, defaultProvider);
  }
});

test("missing configuration disables both tools; invalid files fail without being rewritten", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "web-access.json");
  assert.deepEqual(await loadConfig(path), {});
  const enabled = {
    fetch: { providers: { exa: { maxAgeHours: 24 } }, defaultProvider: "exa" as const },
  };
  await writeFile(path, JSON.stringify(enabled));
  assert.deepEqual(await loadConfig(path), enabled);
  for (const source of [
    "{",
    '{"fetch":false}',
    '{"fetch":{"provider":"exa"}}',
    '{"unknown":true}',
  ]) {
    await writeFile(path, source);
    await assert.rejects(loadConfig(path), /Invalid web access configuration/u);
    assert.equal(await readFile(path, "utf8"), source);
  }
  await assert.rejects(loadConfig(directory), /Cannot read web access configuration/u);
});
