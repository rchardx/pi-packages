import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_REQUESTS,
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

test("parseConfig defaults to no built-in roles and parses user role definitions", () => {
  assert.throws(
    () => resolveRole(parseConfig({}), "researcher"),
    /Unknown subagent role "researcher"\. No roles are configured\./u,
  );
  assert.deepEqual(parseConfig({}), {
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    maxRequests: DEFAULT_MAX_REQUESTS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
    roles: {},
  });
  assert.equal(DEFAULT_MAX_CONCURRENT, 8);
  assert.deepEqual(parseConfig({ maxConcurrent: 4, maxRequests: 16, deadlineSeconds: 300 }), {
    maxConcurrent: 4,
    maxRequests: 16,
    deadlineSeconds: 300,
    roles: {},
  });
  assert.equal(parseConfig({ deadlineSeconds: 0.5 }).deadlineSeconds, 0.5);
  assert.equal(
    parseConfig({ deadlineSeconds: MAX_DEADLINE_SECONDS }).deadlineSeconds,
    MAX_DEADLINE_SECONDS,
  );

  // `false` disables a role entry; configured roles keep only their declared fields.
  const parsed = parseConfig({
    roles: {
      explorer: {
        description: "Fast read-only navigation.",
        provider: "openrouter",
        model: "anthropic/claude-haiku-4-5",
        thinking: "low",
        tools: ["read", "grep", "find", "ls"],
        maxRequests: 12,
        deadlineSeconds: 180,
      },
      disabled_role: false,
      solver: {
        tools: [],
      },
    },
  });
  assert.deepEqual(parsed.roles, {
    explorer: {
      description: "Fast read-only navigation.",
      provider: "openrouter",
      model: "anthropic/claude-haiku-4-5",
      thinking: "low",
      tools: ["read", "grep", "find", "ls"],
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
    ["subagent_list"],
    ["+subagent_list"],
  ]) {
    assert.throws(
      () => parseConfig({ roles: { explorer: { tools: badTools } } }),
      /Role "explorer"/u,
      `expected rejection for tools ${JSON.stringify(badTools)}`,
    );
  }
  assert.throws(
    () => parseConfig({ roles: { explorer: { tools: ["read", "subagent_list"] } } }),
    /cannot enable root-session tools \(subagent, subagent_cancel, subagent_list\)/u,
  );
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
  const empty = parseConfig({});
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
      disabled_role: false,
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
    roles: {},
  });

  await writeFile(path, JSON.stringify({ maxConcurrent: 2, maxRequests: 10 }));
  assert.deepEqual(await loadConfig(path), {
    maxConcurrent: 2,
    maxRequests: 10,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
    roles: {},
  });

  await writeFile(path, "{invalid");
  await assert.rejects(loadConfig(path), /Invalid subagents configuration/u);

  await writeFile(path, JSON.stringify({ extra: true }));
  await assert.rejects(loadConfig(path), /Unknown configuration field/u);
});
