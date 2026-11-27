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

  const location = theme.fg("dim", pwd);
  const separator = theme.fg("dim", " · ");
  const ellipsis = theme.fg("dim", "...");
  const statuses = orderExtensionStatuses(state.extensionStatuses);
  let pwdLine: string;
  if (statuses.length === 0) {
    pwdLine = truncateToWidth(location, width, ellipsis);
  } else {
    const statusText = statuses
      .map((status) => (status.includes("\u001b") ? status : theme.fg("dim", status)))
      .join(separator);
    const fullLine = `${location}${separator}${statusText}`;
    const availableForLocation = width - visibleWidth(separator) - visibleWidth(statusText);
    if (visibleWidth(fullLine) <= width) {
      pwdLine = fullLine;
    } else if (availableForLocation > visibleWidth(ellipsis)) {
      const truncatedLocation = truncateToWidth(location, availableForLocation, ellipsis);
      pwdLine = `${truncatedLocation}${separator}${statusText}`;
    } else {
      pwdLine = truncateToWidth(statusText, width, ellipsis);
    }
  }

  const modelName = state.model?.id ?? "no-model";
  let modelText = modelName;
  if (state.model?.reasoning) {
    const level = state.thinkingLevel || "off";
    modelText = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
  }
  if (state.availableProviderCount > 1 && state.model) {
    modelText = `${modelText} (${state.model.provider})`;
  }

  const { usageTotals, contextUsage } = state;
  const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent =
    contextUsage && contextUsage.percent !== null ? contextPercentValue.toFixed(1) : "?";
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

  const line2Segments = [theme.fg("dim", modelText), styledContext];
  if (usageTotals.cost || state.model?.usingSubscription) {
    line2Segments.push(
      theme.fg(
        "dim",
        `$${usageTotals.cost.toFixed(3)}${state.model?.usingSubscription ? " (sub)" : ""}`,
      ),
    );
  }

  const tokenParts: string[] = [];
  if (usageTotals.input) tokenParts.push(`↑${formatTokens(usageTotals.input)}`);
  if (usageTotals.output) tokenParts.push(`↓${formatTokens(usageTotals.output)}`);
  if (usageTotals.cacheRead) tokenParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
  if (usageTotals.cacheWrite) tokenParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
  if (
    (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) &&
    state.latestCacheHitRate !== undefined
  ) {
    tokenParts.push(`CH${state.latestCacheHitRate.toFixed(1)}%`);
  }
  if (tokenParts.length > 0) {
    line2Segments.push(theme.fg("dim", tokenParts.join(" ")));
  }

  const statsLine = truncateToWidth(line2Segments.join(separator), width, ellipsis);

  return [pwdLine, statsLine];
}

export function isUsingSubscription(
  model: NonNullable<ExtensionContext["model"]>,
  modelRegistry: {
    isUsingOAuth(target: NonNullable<ExtensionContext["model"]>): boolean;
    getProvider(id: string): { auth: { oauth?: { isSubscription?: boolean } } } | undefined;
  },
): boolean {
  // Kimi Coding is subscription-backed despite using API-key authentication.
  return (
    model.provider === "kimi-coding" ||
    (modelRegistry.isUsingOAuth(model) &&
      modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true)
  );
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
            usingSubscription: isUsingSubscription(model, ctx.modelRegistry),
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
