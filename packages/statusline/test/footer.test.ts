import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  accumulateSessionStats,
  formatCwd,
  formatTokens,
  isUsingSubscription,
  orderExtensionStatuses,
  renderStatuslineRows,
  type StatuslineState,
} from "../src/footer.ts";

const plainTheme = {
  fg: (_token: string, text: string) => text,
};

const taggedTheme = {
  fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
};

function baseState(overrides: Partial<StatuslineState> = {}): StatuslineState {
  return {
    cwd: "/home/dev/projects/pi-packages",
    home: "/home/dev",
    branch: "main",
    extensionStatuses: new Map(),
    usageTotals: {
      input: 208_000,
      output: 25_000,
      cacheRead: 1_400_000,
      cacheWrite: 0,
      cost: 0.809,
    },
    latestCacheHitRate: 97.4,
    contextUsage: {
      tokens: 99_000,
      contextWindow: 1_000_000,
      percent: 9.9,
    },
    autoCompactEnabled: true,
    model: {
      id: "claude-opus-4-6",
      provider: "anthropic",
      reasoning: true,
      contextWindow: 1_000_000,
      usingSubscription: false,
    },
    thinkingLevel: "high",
    availableProviderCount: 2,
    ...overrides,
  };
}

test("formatTokens and formatCwd match Pi footer conventions", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(208_400), "208k");
  assert.equal(formatTokens(1_400_000), "1.4M");
  assert.equal(formatTokens(12_400_000), "12M");

  assert.equal(formatCwd("/home/dev", "/home/dev"), "~");
  assert.equal(formatCwd("/home/dev/projects/pi-packages", "/home/dev"), "~/projects/pi-packages");
  assert.equal(formatCwd("/opt/work", "/home/dev"), "/opt/work");
  assert.equal(formatCwd("/home/devkit", "/home/dev"), "/home/devkit");
});

test("orderExtensionStatuses places subagents first, background second, then alphabetical keys", () => {
  const statuses = new Map<string, string>([
    ["zeta", "zeta: active"],
    ["background", "  background: 1\nrunning  "],
    ["alpha", "alpha: ready"],
    ["empty", "   \n\t  "],
    ["subagents", "subagents: 2 running"],
  ]);
  assert.deepEqual(orderExtensionStatuses(statuses), [
    "subagents: 2 running",
    "background: 1 running",
    "alpha: ready",
    "zeta: active",
  ]);
});

test("renderStatuslineRows appends inline statuses on line 1 and keeps native stats on line 2", () => {
  const statuses = new Map<string, string>([
    ["background", "background: 1 running"],
    ["subagents", "subagents: 2 running"],
  ]);
  const [line1, line2] = renderStatuslineRows(
    baseState({ extensionStatuses: statuses }),
    120,
    plainTheme,
  );
  assert.equal(
    line1,
    "~/projects/pi-packages (main) · subagents: 2 running · background: 1 running",
  );
  assert.match(line2, /^↑208k ↓25k R1\.4M CH97\.4% \$0\.809 9\.9%\/1\.0M \(auto\) +/u);
  assert.ok(line2.endsWith("(anthropic) claude-opus-4-6 • high"));
  assert.equal(visibleWidth(line2), 120);
});

test("renderStatuslineRows handles session names, subscription labels, thresholds, and narrow widths", () => {
  const [withNameLine1, warningLine2] = renderStatuslineRows(
    baseState({
      sessionName: "refactor\nauth",
      extensionStatuses: new Map([["subagents", "subagents: 1 running"]]),
      contextUsage: { tokens: 750_000, contextWindow: 1_000_000, percent: 75 },
      model: {
        id: "claude-opus-4-6",
        provider: "anthropic",
        reasoning: true,
        contextWindow: 1_000_000,
        usingSubscription: true,
      },
      thinkingLevel: "off",
    }),
    120,
    taggedTheme,
  );
  assert.match(
    withNameLine1,
    /~\/*projects\/pi-packages \(main\) • refactor auth<\/dim><dim> · <\/dim><dim>subagents: 1 running/u,
  );
  assert.match(warningLine2, /\$0\.809 \(sub\)/u);
  assert.match(warningLine2, /<warning>75\.0%\/1\.0M \(auto\)<\/warning>/u);
  assert.match(warningLine2, /claude-opus-4-6 • thinking off/u);

  const [, errorLine2] = renderStatuslineRows(
    baseState({
      contextUsage: { tokens: 950_000, contextWindow: 1_000_000, percent: 95 },
    }),
    120,
    taggedTheme,
  );
  assert.match(errorLine2, /<error>95\.0%\/1\.0M \(auto\)<\/error>/u);

  for (const width of [24, 50, 72]) {
    const rows = renderStatuslineRows(
      baseState({
        extensionStatuses: new Map([
          ["subagents", "subagents: 8 running"],
          ["background", "background: 4 running"],
        ]),
      }),
      width,
      plainTheme,
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= width, `row exceeded width ${width}: ${row}`);
    }
  }
});

test("accumulateSessionStats sums usage across entry kinds and tracks latest assistant cache hit rate", () => {
  const entries = [
    {
      type: "usage",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      kind: "cache_warm",
      provider: "anthropic",
      model: "claude",
      usage: {
        input: 100,
        output: 0,
        cacheRead: 900,
        cacheWrite: 0,
        totalTokens: 1000,
        cost: { input: 0.01, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.02 },
      },
    },
    {
      type: "message",
      id: "m1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: {
          input: 200,
          output: 50,
          cacheRead: 800,
          cacheWrite: 0,
          totalTokens: 1050,
          cost: { input: 0.02, output: 0.01, cacheRead: 0.01, cacheWrite: 0, total: 0.04 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    },
  ] satisfies SessionEntry[];

  const stats = accumulateSessionStats(entries);
  assert.deepEqual(stats.usageTotals, {
    input: 300,
    output: 50,
    cacheRead: 1700,
    cacheWrite: 0,
    cost: 0.06,
  });
  assert.equal(stats.latestCacheHitRate, 80);
});

test("isUsingSubscription distinguishes non-subscription OAuth from subscription billing", () => {
  const makeModel = (provider: string): NonNullable<ExtensionContext["model"]> => ({
    id: "test-model",
    name: "Test",
    api: "openai-completions",
    provider,
    baseUrl: "https://api.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  });
  const providerWith = (isSubscription?: boolean) => ({
    auth: {
      oauth: isSubscription === undefined ? {} : { isSubscription },
    },
  });

  // Non-subscription OAuth (such as Radius) must not be labeled as subscription billing.
  assert.equal(
    isUsingSubscription(makeModel("radius"), {
      isUsingOAuth: () => true,
      getProvider: () => providerWith(undefined),
    }),
    false,
  );
  assert.equal(
    isUsingSubscription(makeModel("radius"), {
      isUsingOAuth: () => true,
      getProvider: () => providerWith(false),
    }),
    false,
  );
  // Official subscriptions (OpenAI / Anthropic OAuth) require active OAuth and isSubscription === true.
  assert.equal(
    isUsingSubscription(makeModel("anthropic"), {
      isUsingOAuth: () => true,
      getProvider: () => providerWith(true),
    }),
    true,
  );
  // Official API keys on subscription-capable providers are not subscriptions.
  assert.equal(
    isUsingSubscription(makeModel("openai"), {
      isUsingOAuth: () => false,
      getProvider: () => providerWith(true),
    }),
    false,
  );
});
