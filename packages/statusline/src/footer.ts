import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PRIORITY_STATUS_KEYS = ["subagents", "background"] as const;
const MIN_RIGHT_PADDING = 2;

export type FooterTheme = Pick<Theme, "fg">;

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ModelSummary {
  id: string;
  provider: string;
  reasoning: boolean;
  contextWindow: number;
  usingSubscription: boolean;
}

export interface StatuslineState {
  cwd: string;
  home?: string;
  branch: string | null;
  sessionName?: string;
  extensionStatuses: ReadonlyMap<string, string>;
  usageTotals: UsageTotals;
  latestCacheHitRate?: number;
  contextUsage?: ContextUsage;
  autoCompactEnabled: boolean;
  model?: ModelSummary;
  thinkingLevel: string;
  availableProviderCount: number;
}

export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/gu, " ")
    .replace(/ +/gu, " ")
    .trim();
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function orderExtensionStatuses(statuses: ReadonlyMap<string, string>): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of PRIORITY_STATUS_KEYS) {
    const raw = statuses.get(key);
    if (raw !== undefined) {
      seen.add(key);
      const clean = sanitizeStatusText(raw);
      if (clean) ordered.push(clean);
    }
  }
  const remaining = [...statuses.entries()]
    .filter(([key]) => !seen.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [, raw] of remaining) {
    const clean = sanitizeStatusText(raw);
    if (clean) ordered.push(clean);
  }
  return ordered;
}

export function accumulateSessionStats(entries: readonly SessionEntry[]): {
  usageTotals: UsageTotals;
  latestCacheHitRate?: number;
} {
  const usageTotals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  let latestCacheHitRate: number | undefined;
  const add = (usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  }) => {
    usageTotals.input += usage.input;
    usageTotals.output += usage.output;
    usageTotals.cacheRead += usage.cacheRead;
    usageTotals.cacheWrite += usage.cacheWrite;
    usageTotals.cost += usage.cost.total;
  };
  for (const entry of entries) {
    if (entry.type === "usage") {
      add(entry.usage);
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      add(entry.message.usage);
      const latestPromptTokens =
        entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
      latestCacheHitRate =
        latestPromptTokens > 0
          ? (entry.message.usage.cacheRead / latestPromptTokens) * 100
          : undefined;
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage
    ) {
      add(entry.message.usage);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      add(entry.usage);
    }
  }
  return {
    usageTotals,
    ...(latestCacheHitRate !== undefined ? { latestCacheHitRate } : {}),
  };
}

export function renderStatuslineRows(
  state: StatuslineState,
  width: number,
  theme: FooterTheme,
): [string, string] {
  let pwd = formatCwd(state.cwd, state.home);
  if (state.branch) pwd = `${pwd} (${state.branch})`;
  const cleanSessionName = state.sessionName ? sanitizeStatusText(state.sessionName) : "";
  if (cleanSessionName) pwd = `${pwd} • ${cleanSessionName}`;

  const statuses = orderExtensionStatuses(state.extensionStatuses);
  const separator = theme.fg("dim", " · ");
  const line1Segments = [
    theme.fg("dim", pwd),
    ...statuses.map((status) => (status.includes("\u001b") ? status : theme.fg("dim", status))),
  ];
  const pwdLine = truncateToWidth(line1Segments.join(separator), width, theme.fg("dim", "..."));

  const { usageTotals, contextUsage } = state;
  const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent =
    contextUsage && contextUsage.percent !== null ? contextPercentValue.toFixed(1) : "?";

  const prefixParts: string[] = [];
  if (usageTotals.input) prefixParts.push(`↑${formatTokens(usageTotals.input)}`);
  if (usageTotals.output) prefixParts.push(`↓${formatTokens(usageTotals.output)}`);
  if (usageTotals.cacheRead) prefixParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
  if (usageTotals.cacheWrite) prefixParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
  if (
    (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) &&
    state.latestCacheHitRate !== undefined
  ) {
    prefixParts.push(`CH${state.latestCacheHitRate.toFixed(1)}%`);
  }
  if (usageTotals.cost || state.model?.usingSubscription) {
    prefixParts.push(
      `$${usageTotals.cost.toFixed(3)}${state.model?.usingSubscription ? " (sub)" : ""}`,
    );
  }

  const autoIndicator = state.autoCompactEnabled ? " (auto)" : "";
  const contextPercentDisplay =
    contextPercent === "?"
      ? `?/${formatTokens(contextWindow)}${autoIndicator}`
      : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
  const styledContext =
    contextPercentValue > 90
      ? theme.fg("error", contextPercentDisplay)
      : contextPercentValue > 70
        ? theme.fg("warning", contextPercentDisplay)
        : theme.fg("dim", contextPercentDisplay);

  const prefixText = prefixParts.join(" ");
  let statsLeft = prefixText
    ? `${theme.fg("dim", `${prefixText} `)}${styledContext}`
    : styledContext;
  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, theme.fg("dim", "..."));
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const modelName = state.model?.id ?? "no-model";
  let rightWithoutProvider = modelName;
  if (state.model?.reasoning) {
    const level = state.thinkingLevel || "off";
    rightWithoutProvider =
      level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
  }
  let rightSide = rightWithoutProvider;
  if (state.availableProviderCount > 1 && state.model) {
    rightSide = `(${state.model.provider}) ${rightWithoutProvider}`;
    if (statsLeftWidth + MIN_RIGHT_PADDING + visibleWidth(rightSide) > width) {
      rightSide = rightWithoutProvider;
    }
  }

  const rightSideWidth = visibleWidth(rightSide);
  let statsLine: string;
  if (statsLeftWidth + MIN_RIGHT_PADDING + rightSideWidth <= width) {
    const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
    statsLine = statsLeft + theme.fg("dim", padding + rightSide);
  } else {
    const availableForRight = width - statsLeftWidth - MIN_RIGHT_PADDING;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      const padding = " ".repeat(
        Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
      );
      statsLine = statsLeft + theme.fg("dim", padding + truncatedRight);
    } else {
      statsLine = statsLeft;
    }
  }

  return [pwdLine, statsLine];
}

interface CachedStats {
  sessionId: string;
  leafId: string | null;
  entryCount: number;
  modelKey: string;
  usageTotals: UsageTotals;
  latestCacheHitRate?: number;
  contextUsage?: ContextUsage;
}

export function createStatuslineFooter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tui: TUI,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
): Component & { dispose(): void } {
  const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
  let cached: CachedStats | undefined;

  const readStats = (): CachedStats => {
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const entries = ctx.sessionManager.getEntries();
    const entryCount = entries.length;
    const model = ctx.model;
    const modelKey = model ? `${model.provider}/${model.id}` : "";
    if (
      cached &&
      cached.sessionId === sessionId &&
      cached.leafId === leafId &&
      cached.entryCount === entryCount &&
      cached.modelKey === modelKey
    ) {
      return cached;
    }
    const accumulated = accumulateSessionStats(entries);
    const contextUsage = ctx.getContextUsage();
    cached = {
      sessionId,
      leafId,
      entryCount,
      modelKey,
      usageTotals: accumulated.usageTotals,
      ...(accumulated.latestCacheHitRate !== undefined
        ? { latestCacheHitRate: accumulated.latestCacheHitRate }
        : {}),
      ...(contextUsage !== undefined ? { contextUsage } : {}),
    };
    return cached;
  };

  return {
    dispose() {
      unsubscribeBranch();
    },
    invalidate() {
      cached = undefined;
    },
    render(width: number): string[] {
      const stats = readStats();
      const model = ctx.model;
      const home = process.env.HOME || process.env.USERPROFILE;
      const sessionName = ctx.sessionManager.getSessionName();
      const modelSummary: ModelSummary | undefined = model
        ? {
            id: model.id,
            provider: model.provider,
            reasoning: model.reasoning,
            contextWindow: model.contextWindow,
            usingSubscription:
              model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model),
          }
        : undefined;
      return renderStatuslineRows(
        {
          cwd: ctx.sessionManager.getCwd(),
          ...(home !== undefined ? { home } : {}),
          branch: footerData.getGitBranch(),
          ...(sessionName !== undefined ? { sessionName } : {}),
          extensionStatuses: footerData.getExtensionStatuses(),
          usageTotals: stats.usageTotals,
          ...(stats.latestCacheHitRate !== undefined
            ? { latestCacheHitRate: stats.latestCacheHitRate }
            : {}),
          ...(stats.contextUsage !== undefined ? { contextUsage: stats.contextUsage } : {}),
          autoCompactEnabled: pi.getSettings().compaction?.enabled !== false,
          ...(modelSummary !== undefined ? { model: modelSummary } : {}),
          thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
          availableProviderCount: footerData.getAvailableProviderCount(),
        },
        width,
        theme,
      );
    },
  };
}
