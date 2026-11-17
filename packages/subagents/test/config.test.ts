import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  BUILTIN_ROLES,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_REQUESTS,
  defaultRoles,
  formatRolesPrompt,
  loadConfig,
  MAX_DEADLINE_SECONDS,
  parseConfig,
  resolveRole,
} from "../src/config.ts";
import {
  MAX_ROLE_DESCRIPTION_BYTES,
  MAX_ROLE_INSTRUCTIONS_BYTES,
  MAX_ROLE_TOOLS,
} from "../src/protocol.ts";

test("parseConfig includes built-in explorer and librarian roles and merges user overrides", () => {
  assert.deepEqual(Object.keys(BUILTIN_ROLES), ["explorer", "librarian"]);
  assert.ok(BUILTIN_ROLES.librarian);
  assert.equal(
    BUILTIN_ROLES.librarian.description,
    "Find documentation and reference material. No local edits or shell commands.",
  );
  assert.equal(
    BUILTIN_ROLES.librarian.instructions,
    "Find documentation, web sources, and reference code relevant to the task. Cite source URLs or exact file paths. Do not modify local files or run shell commands.",
  );
  assert.throws(
    () => resolveRole(parseConfig({}), "researcher"),
    /Unknown subagent role "researcher"\. Configured roles: explorer, librarian\./u,
  );
  assert.deepEqual(parseConfig({}), {
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    maxRequests: DEFAULT_MAX_REQUESTS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
    roles: defaultRoles(),
  });
  assert.equal(DEFAULT_MAX_CONCURRENT, 8);
  assert.deepEqual(parseConfig({ maxConcurrent: 4, maxRequests: 16, deadlineSeconds: 300 }), {
    maxConcurrent: 4,
    maxRequests: 16,
    deadlineSeconds: 300,
    roles: defaultRoles(),
  });
  assert.equal(parseConfig({ deadlineSeconds: 0.5 }).deadlineSeconds, 0.5);
  assert.equal(
    parseConfig({ deadlineSeconds: MAX_DEADLINE_SECONDS }).deadlineSeconds,
    MAX_DEADLINE_SECONDS,
  );

  // Partial override on built-in `explorer` preserves built-in tools/instructions; `false` disables `librarian`.
  const parsed = parseConfig({
    roles: {
      explorer: {
        provider: "openrouter",
        model: "anthropic/claude-haiku-4-5",
        thinking: "low",
        maxRequests: 12,
        deadlineSeconds: 180,
      },
      librarian: false,
      solver: {
        tools: [],
      },
    },
  });
  assert.deepEqual(parsed.roles, {
    explorer: {
      ...BUILTIN_ROLES.explorer,
      provider: "openrouter",
      model: "anthropic/claude-haiku-4-5",
      thinking: "low",
      maxRequests: 12,
      deadlineSeconds: 180,
    },
    solver: {
      tools: [],
    },
  });
});

test("researcher is an ordinary custom role without built-in restrictions", () => {
  const configured = parseConfig({ roles: { researcher: { description: "Custom research." } } });
  assert.deepEqual(configured.roles.researcher, { description: "Custom research." });
});

test("parseConfig rejects invalid input", () => {
  assert.throws(() => parseConfig(null), /JSON object/u);
  assert.throws(() => parseConfig([]), /JSON object/u);
  assert.throws(() => parseConfig({ maxJobs: 4 }), /Unknown configuration field/u);
  assert.throws(() => parseConfig({ maxConcurrent: 0 }), /positive integer/u);
  assert.throws(() => parseConfig({ maxConcurrent: 2.5 }), /positive integer/u);
  assert.throws(() => parseConfig({ maxRequests: 0 }), /positive integer/u);
  assert.throws(() => parseConfig({ maxRequests: -3 }), /positive integer/u);
  assert.throws(() => parseConfig({ deadlineSeconds: 0 }), /positive number/u);
  assert.throws(() => parseConfig({ deadlineSeconds: -1 }), /positive number/u);
  assert.throws(() => parseConfig({ deadlineSeconds: Number.NaN }), /positive number/u);
  assert.throws(
    () => parseConfig({ deadlineSeconds: MAX_DEADLINE_SECONDS + 1 }),
    /positive number/u,
  );

  assert.throws(() => parseConfig({ roles: null }), /roles must be a JSON object/u);
  assert.throws(() => parseConfig({ roles: [] }), /roles must be a JSON object/u);
  for (const badName of [
    "",
    "-bad",
    "_bad",
    "bad name",
    "a".repeat(65),
    "constructor",
    "prototype",
  ]) {
    assert.throws(
      () => parseConfig({ roles: { [badName]: {} } }),
      /Invalid role name/u,
      `expected rejection for role name "${badName}"`,
    );
  }
  assert.throws(() => parseConfig(JSON.parse('{"roles":{"__proto__":{}}}')), /Invalid role name/u);
  assert.throws(() => parseConfig({ roles: { explorer: [] } }), /must be a JSON object or false/u);
  assert.throws(
    () => parseConfig({ roles: { explorer: true } }),
    /must be a JSON object or false/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: null } }),
    /must be a JSON object or false/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { excludeTools: ["write"] } } }),
    /Unknown field "excludeTools"/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { provider: "openai" } } }),
    /provider and model together/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { model: "gpt-5" } } }),
    /provider and model together/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { provider: "open ai", model: "gpt-5" } } }),
    /provider and model must be nonempty/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { thinking: "turbo" } } }),
    /thinking must be one of/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { description: "   " } } }),
    /single-line nonempty/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { description: "line1\nline2" } } }),
    /single-line nonempty/u,
  );
  assert.throws(
    () =>
      parseConfig({
        roles: { explorer: { description: "x".repeat(MAX_ROLE_DESCRIPTION_BYTES + 1) } },
      }),
    /at most/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { instructions: "   " } } }),
    /instructions must be nonempty/u,
  );
  assert.throws(
    () =>
      parseConfig({
        roles: { explorer: { instructions: "x".repeat(MAX_ROLE_INSTRUCTIONS_BYTES + 1) } },
      }),
    /instructions must be nonempty and at most/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { tools: "read" } } }),
    /tools must be an array/u,
  );
  assert.throws(
    () =>
      parseConfig({
        roles: {
          explorer: { tools: Array.from({ length: MAX_ROLE_TOOLS + 1 }, (_, i) => `t${i}`) },
        },
      }),
    /at most/u,
  );
  for (const badTools of [
    [""],
    ["read,write"],
    ["read write"],
    ["mcp__*"],
    ["+"],
    ["-"],
    ["read", "-write"],
    ["subagent"],
    ["+subagent"],
    ["+subagent_cancel"],
  ]) {
    assert.throws(
      () => parseConfig({ roles: { explorer: { tools: badTools } } }),
      /Role "explorer"/u,
      `expected rejection for tools ${JSON.stringify(badTools)}`,
    );
  }
  assert.throws(
    () => parseConfig({ roles: { explorer: { maxRequests: 0 } } }),
    /maxRequests must be a positive integer/u,
  );
  assert.throws(
    () => parseConfig({ roles: { explorer: { deadlineSeconds: -5 } } }),
    /deadlineSeconds must be a positive number/u,
  );
});

test("resolveRole and formatRolesPrompt enforce exact lookup and concise prompt formatting", () => {
  const empty = parseConfig({ roles: { explorer: false, librarian: false } });
  assert.equal(resolveRole(empty, undefined), undefined);
  assert.equal(formatRolesPrompt(empty.roles), undefined);
  assert.throws(() => resolveRole(empty, ""), /nonempty/u);
  assert.throws(() => resolveRole(empty, "   "), /nonempty/u);
  assert.throws(() => resolveRole(empty, "explorer"), /No roles are configured/u);
  assert.throws(() => resolveRole(empty, "toString"), /No roles are configured/u);

  const configured = parseConfig({
    roles: {
      explorer: {
        description: "Fast read-only navigation.",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        thinking: "low",
        tools: ["read", "grep"],
      },
      librarian: false,
      solver: {
        tools: [],
      },
    },
  });
  assert.equal(resolveRole(configured, " explorer ")?.name, "explorer");
  assert.throws(() => resolveRole(configured, "missing"), /Configured roles: explorer, solver\./u);
  assert.throws(() => resolveRole(configured, "constructor"), /Unknown subagent role/u);
  assert.equal(
    formatRolesPrompt(configured.roles),
    "Configured subagent roles (pass `role` to `subagent`, or omit `role` for a general-purpose child):\n" +
      "- explorer (anthropic/claude-haiku-4-5; thinking: low; tools: read, grep): Fast read-only navigation.\n" +
      "- solver (tools: none)",
  );
});

test("loadConfig returns defaults when missing and fails closed when invalid", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "subagents.json");

  assert.deepEqual(await loadConfig(path), {
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    maxRequests: DEFAULT_MAX_REQUESTS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
    roles: defaultRoles(),
  });

  await writeFile(path, JSON.stringify({ maxConcurrent: 2, maxRequests: 10 }));
  assert.deepEqual(await loadConfig(path), {
    maxConcurrent: 2,
    maxRequests: 10,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
    roles: defaultRoles(),
  });

  await writeFile(path, "{invalid");
  await assert.rejects(loadConfig(path), /Invalid subagents configuration/u);

  await writeFile(path, JSON.stringify({ extra: true }));
  await assert.rejects(loadConfig(path), /Unknown configuration field/u);
});
