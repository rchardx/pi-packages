import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import {
  appendHistoryEntry,
  MAX_ENTRY_BYTES,
  MAX_HISTORY_ENTRIES,
  readHistory,
} from "./src/store.ts";

type CustomEditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

interface SessionFallbackRecord {
  entries: string[];
  hasUnpersisted: boolean;
}

const SESSION_FALLBACKS_KEY = Symbol.for("@rchardx/pi-prompt-history/session-fallbacks");

function getSessionFallbacks(): Map<string, SessionFallbackRecord> {
  const globalStore = globalThis as Record<symbol, unknown>;
  let map = globalStore[SESSION_FALLBACKS_KEY] as Map<string, SessionFallbackRecord> | undefined;
  if (!map) {
    map = new Map();
    globalStore[SESSION_FALLBACKS_KEY] = map;
  }
  return map;
}

function appendBoundedEntry(target: string[], text: string): void {
  if (target.at(-1) === text) return;
  target.push(text);
  if (target.length > MAX_HISTORY_ENTRIES) {
    target.splice(0, target.length - MAX_HISTORY_ENTRIES);
  }
}

function createSeededEditorFactory(
  baseFactory: CustomEditorFactory | undefined,
  entries: readonly string[],
): CustomEditorFactory {
  return (tui, theme, keybindings) => {
    const editor = baseFactory
      ? baseFactory(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
    for (const entry of entries) {
      editor.addToHistory?.(entry);
    }
    return editor;
  };
}

export default function promptHistory(pi: ExtensionAPI): void {
  const sessionFallbacks = getSessionFallbacks();
  let shuttingDown = false;
  let activeStorageNoticeKey: string | undefined;
  let boundSessionFile: string | undefined;
  const pendingWrites = new Set<Promise<void>>();

  const notifyStorageIssueOnce = (ctx: ExtensionContext, key: string, message: string): void => {
    if (activeStorageNoticeKey === key) return;
    activeStorageNoticeKey = key;
    ctx.ui.notify(message, "warning");
  };

  pi.on("session_start", async (event, ctx) => {
    shuttingDown = false;
    activeStorageNoticeKey = undefined;
    boundSessionFile = ctx.sessionManager.getSessionFile();
    if (ctx.mode !== "tui" || boundSessionFile === undefined) return;

    const loaded = await readHistory(ctx.cwd);
    if (shuttingDown) return;

    let diskEntries: string[] = [];
    if (loaded.status === "ok") {
      diskEntries = loaded.entries;
    } else if (loaded.status === "corrupt") {
      notifyStorageIssueOnce(
        ctx,
        `corrupt:${loaded.path}`,
        `Prompt history storage is corrupt and was left untouched (${loaded.path}): ${loaded.message}`,
      );
    } else {
      notifyStorageIssueOnce(
        ctx,
        `io:${loaded.path}`,
        `Prompt history could not be loaded (${loaded.path}): ${loaded.message}`,
      );
    }

    let fallback = sessionFallbacks.get(boundSessionFile);
    if (!fallback) {
      fallback = { entries: [...diskEntries], hasUnpersisted: false };
      sessionFallbacks.set(boundSessionFile, fallback);
    } else if (!fallback.hasUnpersisted) {
      fallback.entries = [...diskEntries];
    }
    const entries = fallback.hasUnpersisted ? fallback.entries : diskEntries;

    if (event.reason === "startup" && entries.length === 0) {
      return;
    }

    const baseFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent(createSeededEditorFactory(baseFactory, entries));
  });

  pi.on("input", (event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (ctx.mode !== "tui" || event.source !== "interactive" || sessionFile === undefined) {
      return;
    }
    if (event.text.trim().length === 0) {
      return;
    }

    let fallback = sessionFallbacks.get(sessionFile);
    if (!fallback) {
      fallback = { entries: [], hasUnpersisted: false };
      sessionFallbacks.set(sessionFile, fallback);
    }
    if (Buffer.byteLength(event.text, "utf8") <= MAX_ENTRY_BYTES) {
      appendBoundedEntry(fallback.entries, event.text);
    }

    let writeTask!: Promise<void>;
    writeTask = (async () => {
      try {
        const result = await appendHistoryEntry(ctx.cwd, event.text);
        if (result.status === "corrupt" || result.status === "io_error") {
          fallback.hasUnpersisted = true;
        }
        if (shuttingDown) return;

        switch (result.status) {
          case "saved":
          case "deduplicated":
            activeStorageNoticeKey = undefined;
            break;
          case "ignored_blank":
            break;
          case "skipped_oversized":
            ctx.ui.notify(
              `Prompt exceeds ${formatSize(MAX_ENTRY_BYTES)} history limit (${formatSize(result.byteLength)}); skipped saving to prompt history.`,
              "warning",
            );
            break;
          case "corrupt":
            notifyStorageIssueOnce(
              ctx,
              `corrupt:${result.path}`,
              `Prompt history storage is corrupt and was left untouched (${result.path}): ${result.message}`,
            );
            break;
          case "io_error":
            notifyStorageIssueOnce(
              ctx,
              `io:${result.path}`,
              `Prompt history could not be saved (${result.path}): ${result.message}`,
            );
            break;
          case "prune_error":
            notifyStorageIssueOnce(
              ctx,
              `prune:${result.path}`,
              `Prompt history saved, but old entries could not be pruned (${result.path}): ${result.message}`,
            );
            break;
        }
      } finally {
        pendingWrites.delete(writeTask);
      }
    })();

    pendingWrites.add(writeTask);
  });

  pi.on("session_shutdown", async (event) => {
    shuttingDown = true;
    if (pendingWrites.size > 0) {
      await Promise.allSettled([...pendingWrites]);
    }
    if (event.reason !== "reload" && boundSessionFile !== undefined) {
      sessionFallbacks.delete(boundSessionFile);
    }
    if (event.reason === "quit") {
      sessionFallbacks.clear();
    }
  });
}
