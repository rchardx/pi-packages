import { rm } from "node:fs/promises";
import {
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./src/config.ts";
import {
  createSessionJobs,
  type JobRecord,
  pruneOldLogs,
  SEED_BYTES,
  type SessionJobs,
  TailBuffer,
} from "./src/jobs.ts";
import {
  buildNotification,
  formatDuration,
  NOTIFICATION_TYPE,
  type JobOutcome,
  type NotificationDetails,
  renderNotification,
  tailText,
} from "./src/notify.ts";
import { createTeeOperations } from "./src/operations.ts";

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds; the command is killed when it expires. Without it, a long-running command may move to the background.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: "Run the command in the background and return immediately.",
    }),
  ),
});

/** Structured result of a command that is still running as a background job. */
const backgroundOutputSchema = Type.Object({
  job_id: Type.String(),
  log_path: Type.Optional(Type.String()),
  output: Type.String({ description: "Output captured before the job moved to the background" }),
});

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let handle: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    handle.unref();
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

/** Background execution needs a long-lived session that outlives the turn. */
function backgroundAllowed(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

function updateStatus(ctx: ExtensionContext, session: SessionJobs): void {
  const count = session.shuttingDown ? 0 : session.runningCount();
  ctx.ui.setStatus("background", count > 0 ? `background: ${count} running` : undefined);
}

export default function background(pi: ExtensionAPI) {
  const sessions = new Map<string, SessionJobs>();
  // Renderers, prompt metadata, and sampling config come from the built-in
  // definition; only the description, schema, and execute behavior differ.
  const builtin = createBashToolDefinition(process.cwd(), {});

  function sessionJobs(ctx: ExtensionContext): SessionJobs {
    const sessionId = ctx.sessionManager.getSessionId();
    let state = sessions.get(sessionId);
    if (!state) {
      state = createSessionJobs(sessionId);
      sessions.set(sessionId, state);
    }
    return state;
  }

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx, sessionJobs(ctx));
    await pruneOldLogs();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);
    state.shuttingDown = true;
    updateStatus(ctx, state);
    await state.killAll("session ended");
  });

  pi.registerMessageRenderer<NotificationDetails>(NOTIFICATION_TYPE, renderNotification);

  pi.registerCommand("background", {
    description: "Show running background jobs with elapsed time and full commands",
    handler: async (_args, ctx) => {
      const state = sessions.get(ctx.sessionManager.getSessionId());
      const jobs = state?.runningJobs() ?? [];
      const now = Date.now();
      const rows = jobs.map(
        (job) =>
          `${job.id}  running  ${formatDuration(now - job.startedAtMs)}\n` +
          job.command
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n"),
      );
      ctx.ui.notify(
        rows.length === 0
          ? "No background jobs running."
          : `Background jobs · ${rows.length} running\n\n${rows.join("\n\n")}`,
        "info",
      );
    },
  });

  pi.registerTool({
    name: "bash",
    label: builtin.label,
    description:
      "Execute a bash command in the current working directory.\n\n" +
      "Foreground execution returns stdout and stderr, truncated to the last " +
      `${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output ` +
      "is saved to a temp file.\n\n" +
      "Background execution returns a job id and available log path, then " +
      "notifies automatically on completion.",
    ...(builtin.promptSnippet ? { promptSnippet: builtin.promptSnippet } : {}),
    promptGuidelines: [
      ...(builtin.promptGuidelines ?? []),
      "Use bash background execution for long-running commands when available. Do not poll background jobs or launch duplicate copies; continue other work or end your turn and wait for the completion notification.",
    ],
    parameters,
    // Every successful result carries structured content, so codemode scripts
    // see foreground and background results through one declared type.
    ...(builtin.outputSchema
      ? { outputSchema: Type.Union([builtin.outputSchema, backgroundOutputSchema]) }
      : {}),
    ...(builtin.constrainedSampling ? { constrainedSampling: builtin.constrainedSampling } : {}),
    ...(builtin.renderCall ? { renderCall: builtin.renderCall } : {}),
    ...(builtin.renderResult ? { renderResult: builtin.renderResult } : {}),
    async execute(toolCallId, { command, timeout, background }, signal, onUpdate, ctx) {
      const config = await loadConfig();
      const session = sessionJobs(ctx);
      if (background === true && !backgroundAllowed(ctx)) {
        throw new Error(
          `Background execution is unavailable in ${ctx.mode} mode: the session ` +
            "ends when the turn ends, which would kill the job. Run the command in the " +
            "foreground; use timeout to bound it.",
        );
      }
      if (background === true && session.runningCount() >= config.maxJobs) {
        throw new Error(
          `${session.runningCount()} background jobs are already running (max ${config.maxJobs}). ` +
            "Wait for a completion notification before starting more.",
        );
      }
      const cwd = ctx.cwd;
      // Match the built-in tool's settings: custom shell and command prefix
      // (used for example for shell aliases) apply to every command.
      const settings = pi.getSettings();
      const job: JobRecord = {
        id: session.newJobId(),
        command,
        controller: new AbortController(),
        startedAtMs: Date.now(),
        logPath: null,
        log: null,
        logBytes: 0,
        tail: new TailBuffer(),
        seed: new TailBuffer(SEED_BYTES),
        state: "running",
      };
      // Explicit background jobs register before the first suspension point
      // after the maxJobs check, so parallel calls in one turn are counted.
      // Logs are created lazily at backgrounding time; commands that can
      // never background (explicit timeout, print/json mode) never touch disk.
      if (background === true) {
        session.jobs.set(job.id, job);
        updateStatus(ctx, session);
        await session.openLog(job);
      }

      // Forward turn aborts (Esc) only while the call is in its foreground
      // window; once backgrounded, the job is independent of the turn.
      const forwardAbort = () => job.controller.abort();
      if (signal) {
        if (signal.aborted) job.controller.abort();
        else signal.addEventListener("abort", forwardAbort);
      }
      const stopForwardingToTurn = () => signal?.removeEventListener("abort", forwardAbort);

      const tee = createTeeOperations(
        (data) => {
          if (job.state === "running") {
            job.tail.append(data);
            if (!job.log) job.seed.append(data);
          }
          session.writeOutput(job, data);
        },
        settings.shellPath ? { shellPath: settings.shellPath } : undefined,
      );
      const definition = createBashToolDefinition(cwd, {
        operations: tee.operations,
        ...(settings.shellCommandPrefix ? { commandPrefix: settings.shellCommandPrefix } : {}),
      });
      let uiForwarding = true;
      const execPromise = definition.execute(
        toolCallId,
        { command, ...(timeout === undefined ? {} : { timeout }) },
        job.controller.signal,
        onUpdate
          ? (update) => {
              if (uiForwarding) onUpdate(update);
            }
          : undefined,
        ctx,
      );

      const thresholdMs =
        background === true
          ? 0
          : timeout === undefined && backgroundAllowed(ctx) && config.thresholdSeconds > 0
            ? config.thresholdSeconds * 1000
            : undefined;
      const timer = thresholdMs === undefined ? undefined : sleep(Math.max(thresholdMs, 0));
      const outcome = await Promise.race([
        execPromise.then(
          () => "finished" as const,
          () => "finished" as const,
        ),
        // An explicit timeout, disabled auto-backgrounding, or no background
        // support: the built-in deadline semantics apply and this arm never
        // wins. Handlers attached after a promise settles still fire, so no
        // completion can be lost regardless of when the command exits.
        (timer?.promise ?? new Promise<void>(() => {})).then(() => "backgrounded" as const),
      ]);
      timer?.cancel();
      stopForwardingToTurn();
      uiForwarding = false;

      if (outcome === "finished") {
        if (background === true) {
          session.jobs.delete(job.id);
          updateStatus(ctx, session);
        }
        await session.closeLog(job);
        // Foreground commands keep no log: their output is the tool result.
        if (job.logPath) await rm(job.logPath, { force: true }).catch(() => {});
        return await execPromise;
      }

      tee.stopForwarding();
      if (background !== true) {
        session.jobs.set(job.id, job);
        updateStatus(ctx, session);
      }
      // Initialize before finalizing: execution can settle during mkdir, and
      // attaching handlers afterwards still observes that settlement.
      if (!job.log) await session.openLog(job);
      execPromise.then(
        () =>
          void finalizeJob(
            pi,
            ctx,
            session,
            job,
            tee.outcome() ?? { kind: "error", message: "bash tool returned no result" },
          ),
        (error: unknown) =>
          void finalizeJob(
            pi,
            ctx,
            session,
            job,
            tee.outcome() ?? {
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          ),
      );
      const tail = tailText(job.tail.text());
      const logLine = job.logPath
        ? `Log: ${job.logPath}`
        : "Log unavailable; completion notification will include the output tail.";
      const text =
        background === true
          ? `Started background job ${job.id}.\n${logLine}`
          : `Command exceeded the ${config.thresholdSeconds}s foreground threshold.\n` +
            `Moved to background job ${job.id}.\n${logLine}` +
            (tail ? `\n\nOutput so far:\n${tail}` : "");
      return {
        content: [{ type: "text", text }],
        details: undefined,
        structuredContent: {
          job_id: job.id,
          ...(job.logPath ? { log_path: job.logPath } : {}),
          output: tail,
        },
      };
    },
  });
}

async function finalizeJob(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: SessionJobs,
  job: JobRecord,
  outcome: JobOutcome,
): Promise<void> {
  // Shutdown marks registered jobs ended before ctx becomes stale, so skip UI access then.
  if (job.state !== "running") return;
  job.state = "ended";
  updateStatus(ctx, session);
  const durationMs = Date.now() - job.startedAtMs;
  const { content, details } = buildNotification(job, outcome, durationMs);
  const trailer =
    outcome.kind === "exit"
      ? `\n[pi-background] job ${job.id} ${details.outcome} (exit ${outcome.exitCode}) after ${formatDuration(durationMs)}\n`
      : `\n[pi-background] job ${job.id} ${details.outcome} after ${formatDuration(durationMs)}\n`;
  try {
    await session.appendLog(job, trailer);
  } finally {
    await session.closeLog(job);
  }
  session.jobs.delete(job.id);
  // Aborted jobs are user- or session-initiated stops: never wake the model
  // for them (least of all right after the user pressed Esc).
  if (session.shuttingDown || outcome.kind === "aborted") return;
  try {
    pi.sendMessage(
      { customType: NOTIFICATION_TYPE, content, display: true, details },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch {
    // The session is gone; the log file remains the record of the outcome.
  }
}
