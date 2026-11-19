import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ANTHROPIC_MODEL } from "../src/providers/anthropic.ts";
import { DEFAULT_GOOGLE_MODEL } from "../src/providers/google.ts";
import { OPENAI_BACKENDS } from "../src/providers/openai.ts";

// Built-in defaults must stay in the pinned Pi catalog, so a Pi upgrade that retires one
// fails here instead of at a user's first provider call.
test("default provider models exist in the pinned Pi model catalog", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-access-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new ModelRegistry(
    await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "models.json"),
      modelsStorePath: join(directory, "catalog.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    }),
  );

  for (const [provider, model] of [
    ["anthropic", DEFAULT_ANTHROPIC_MODEL],
    ["google", DEFAULT_GOOGLE_MODEL],
    ["openai", OPENAI_BACKENDS.openai.defaultModel],
    ["openai-codex", OPENAI_BACKENDS["openai-codex"].defaultModel],
  ] as const) {
    assert.equal(registry.find(provider, model)?.id, model, `${provider}/${model}`);
  }
  assert.equal(registry.find("openai", "retired-model"), undefined);
});
