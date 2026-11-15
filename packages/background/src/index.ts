import { rm } from "node:fs/promises";
import {
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import {
  createSessionJobs,
  type JobRecord,
  LOG_OUTPUT_BYTES,
  pruneOldLogs,
  SEED_BYTES,
  type SessionJobs,
  TailBuffer,
} from "./jobs.ts";
import {
  buildNotification,
  formatDuration,
  NOTIFICATION_TYPE,
  type JobOutcome,
  type NotificationDetails,
  oneLine,
  renderNotification,
  tailText,
} from "./notify.ts";
import { createTeeOperations } from "./operations.ts";

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds (optional, no default timeout). A command that exceeds it is killed.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "In tui/rpc mode only, run the command in the background and return immediately " +
        "with a job id and log path. You will be notified when it finishes. " +
        "Unavailable in print/json mode.",
    }),
  ),
});

const NO_POLL_INSTRUCTION =
  "You will be notified automatically when it finishes — do not poll (no `sleep N; check` loops, " +
  "no repeated reads of the log file to wait for completion), and do not start another copy while " +
  "it runs. Continue with other work or, if everything left depends on the result, end your turn " +
  "and you will be resumed.";

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
    sessionJobs(ctx);
    await pruneOldLogs();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);
    state.shuttingDown = true;
    await state.killAll("session ended");
  });

  pi.registerMessageRenderer<NotificationDetails>(NOTIFICATION_TYPE, renderNotification);

  pi.registerTool({
    name: "bash",
    label: builtin.label,
    description:
      builtin.description +
      " Background execution is available only in tui/rpc mode; in print/json mode, " +
      "run commands in the foreground (optionally with timeout). In tui/rpc mode, set " +
      "background to true for long-running commands (builds, test suites, dev servers, " +
      "downloads) to return immediately while the command keeps running. When automatic " +
      "backgrounding is enabled and no explicit timeout is set, commands still running " +
      "after the threshold (default 120s; 0 disables it) move to the background. Background " +
      `jobs log up to ${LOG_OUTPUT_BYTES / (1024 * 1024)} MiB of raw output, then keep running ` +
      "with an updated in-memory tail. They notify you with the exit code and output tail when " +
      "they finish. Do not poll background jobs: no sleep-and-check loops and no repeated " +
      "log reads to wait for completion. If you have nothing else to do, end your turn; " +
      "you will be resumed when the job finishes.",
    ...(builtin.promptSnippet ? { promptSnippet: builtin.promptSnippet } : {}),
    promptGuidelines: [
      ...(builtin.promptGuidelines ?? []),
      "For bash, do not write `sleep N; command` chains to wait for an uncertain duration. In tui/rpc mode, use background: true and act on its completion notification. In print/json mode, run the command in the foreground, optionally with timeout.",
    ],
    parameters,
    ...(builtin.outputSchema ? { outputSchema: builtin.outputSchema } : {}),
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
        session.jobs.delete(job.id);
        await session.closeLog(job);
        // Foreground commands keep no log: their output is the tool result.
        if (job.logPath) await rm(job.logPath, { force: true }).catch(() => {});
        return await execPromise;
      }

      tee.stopForwarding();
      session.jobs.set(job.id, job);
      // Initialize before finalizing: execution can settle during mkdir, and
      // attaching handlers afterwards still observes that settlement.
      if (!job.log) await session.openLog(job);
      execPromise.then(
        () =>
          void finalizeJob(
            pi,
            session,
            job,
            tee.outcome() ?? { kind: "error", message: "bash tool returned no result" },
          ),
        (error: unknown) =>
          void finalizeJob(
            pi,
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
        ? `Output is appended to: ${job.logPath} (up to ${LOG_OUTPUT_BYTES / (1024 * 1024)} MiB of raw output)`
        : "No log file could be created (the agent directory is not writable); " +
          "only the completion notification's output tail will be available.";
      const text =
        background === true
          ? `Started background job ${job.id}: ${oneLine(command)}\n` +
            `${logLine}\n${NO_POLL_INSTRUCTION}`
          : `Command did not finish within ${config.thresholdSeconds}s and was moved to ` +
            `background job ${job.id}.\n` +
            (tail ? `\nOutput so far:\n${tail}\n\n` : "\n") +
            `${logLine}\n${NO_POLL_INSTRUCTION}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

async function finalizeJob(
  pi: ExtensionAPI,
  session: SessionJobs,
  job: JobRecord,
  outcome: JobOutcome,
): Promise<void> {
  if (job.state !== "running") return; // The session already ended this job.
  job.state = "ended";
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
