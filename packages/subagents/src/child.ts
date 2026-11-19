import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentInbox, formatWaitOutcome, waitTimeoutParameter } from "./inbox.ts";
import {
  formatPartialProgress,
  formatMessage,
  summarizeToolCall,
  type ToolActivityState,
} from "./notify.ts";
import {
  bounded,
  CHILD_ENV,
  COMMUNICATION_TOOLS,
  childInstructions,
  formatIncompleteReport,
  isMessageEnvelope,
  isRoleName,
  MAIN_AGENT_ID,
  MAX_ACTIVITY_ENTRIES,
  MAX_MESSAGE_BYTES,
  MAX_PARTIAL_TEXT_BYTES,
  MAX_REQUESTS,
  MAX_WAIT_SECONDS,
  MESSAGE_TYPE,
  type Progress,
  record,
  type Result,
} from "./protocol.ts";

/** Loaded only in the managed CLI process; IPC is separate from extension stdout. */
export default async function child(pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] !== "1" || !process.send) {
    throw new Error("The subagent child extension requires a managed IPC process.");
  }
  const inbox = new AgentInbox();
  const pendingRequests = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  const rejectPendingRequests = (reason: string) => {
    for (const pending of pendingRequests.values()) {
      pending.reject(new Error(reason));
    }
    pendingRequests.clear();
  };

  // Install before waiting for configuration so startup cannot outlive its owner.
  process.on("disconnect", () => {
    rejectPendingRequests("Parent IPC channel disconnected.");
    inbox.clear();
    process.kill(process.pid, "SIGTERM");
  });

  const send = (message: unknown) => {
    if (process.connected) process.send?.(message, () => {});
  };

  let prepared = false;
  let closing = false;
  let session: ExtensionContext | undefined;
  let release: (() => void) | undefined;
  const run = new Promise<void>((resolve) => {
    release = resolve;
  });

  const config = await new Promise<{
    id: string;
    role: string | undefined;
    instructions: string | undefined;
    requiredTools: string[];
    activeTools: string[];
    provider: string;
    model: string;
    modelConfig: { api: string; baseUrl: string } | undefined;
    maxRequests: number;
  }>((resolve) => {
    process.on("message", (message: unknown) => {
      if (!record(message)) return;
      switch (message.type) {
        case "run":
          release?.();
          break;
        case "configure":
          if (
            typeof message.provider === "string" &&
            typeof message.model === "string" &&
            Array.isArray(message.requiredTools) &&
            message.requiredTools.every((tool): tool is string => typeof tool === "string") &&
            Array.isArray(message.activeTools) &&
            message.activeTools.every((tool): tool is string => typeof tool === "string")
          ) {
            const maxRequests =
              typeof message.maxRequests === "number" &&
              Number.isInteger(message.maxRequests) &&
              message.maxRequests >= 1
                ? message.maxRequests
                : MAX_REQUESTS;
            resolve({
              id: typeof message.id === "string" && message.id.length > 0 ? message.id : "child",
              role: isRoleName(message.role) ? message.role : undefined,
              instructions:
                typeof message.instructions === "string" && message.instructions.trim().length > 0
                  ? message.instructions
                  : undefined,
              requiredTools: message.requiredTools,
              activeTools: message.activeTools,
              provider: message.provider,
              model: message.model,
              modelConfig:
                record(message.modelConfig) &&
                typeof message.modelConfig.api === "string" &&
                typeof message.modelConfig.baseUrl === "string"
                  ? { api: message.modelConfig.api, baseUrl: message.modelConfig.baseUrl }
                  : undefined,
              maxRequests,
            });
          }
          break;
        case "deliver":
          if (typeof message.deliveryId !== "string" || !isMessageEnvelope(message.envelope)) {
            break;
          }
          // Pi owns the settlement decision: a message steered into an active run is
          // processed before that run settles, including continuations requested by
          // other extensions. Once the run is idle, accepting would start a new run
          // after the terminal result, so the sender gets an explicit rejection.
          if (!prepared || closing || !session || session.isIdle()) {
            send({
              type: "delivery_ack",
              deliveryId: message.deliveryId,
              accepted: false,
              reason: "finished",
            });
            break;
          }
          if (!inbox.acceptMessage(message.envelope.id)) {
            send({
              type: "delivery_ack",
              deliveryId: message.deliveryId,
              accepted: false,
              reason: "queue_full",
            });
            break;
          }
          try {
            pi.sendMessage(
              {
                customType: MESSAGE_TYPE,
                content: formatMessage(message.envelope),
                display: true,
                details: message.envelope,
              },
              { deliverAs: "steer", triggerTurn: true },
            );
            send({
              type: "delivery_ack",
              deliveryId: message.deliveryId,
              accepted: true,
            });
          } catch {
            inbox.markMessageCommitted(message.envelope.id);
            send({
              type: "delivery_ack",
              deliveryId: message.deliveryId,
              accepted: false,
              reason: "finished",
            });
          }
          break;
        case "send_result":
          if (typeof message.requestId === "string") {
            const pending = pendingRequests.get(message.requestId);
            if (pending) {
              pendingRequests.delete(message.requestId);
              if (typeof message.error === "string") pending.reject(new Error(message.error));
              else pending.resolve();
            }
          }
          break;
      }
    });
    send({ type: "hello" });
  });

  /** Resolves once the root session has accepted the message for its next turn. */
  const sendToParent = (message: string, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new Error("Operation cancelled."));
    if (!process.connected || closing) {
      return Promise.reject(new Error("Parent IPC channel disconnected."));
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        if (pendingRequests.delete(requestId)) {
          reject(new Error("Operation cancelled."));
        }
      };
      pendingRequests.set(requestId, {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      process.send?.({ type: "send", requestId, message }, (error) => {
        if (error && pendingRequests.delete(requestId)) {
          signal?.removeEventListener("abort", onAbort);
          reject(new Error("Child IPC request failed."));
        }
      });
    });
  };

  // A child runs headless, so these tools carry no renderers.
  pi.registerTool({
    name: "subagent_send",
    label: "subagent_send",
    description:
      "Send a message to the parent session that delegated this task. It is queued for the parent's next turn; this does not wait for a reply.",
    parameters: Type.Object({
      message: Type.String({
        description: `Message text (at most ${MAX_MESSAGE_BYTES / 1024} KiB).`,
      }),
    }),
    async execute(_callId, { message }, signal) {
      await sendToParent(message, signal);
      return {
        content: [
          {
            type: "text",
            text: `Queued message for ${MAIN_AGENT_ID} (accepted into recipient queue; not yet processed).`,
          },
        ],
        details: { to: MAIN_AGENT_ID },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "subagent_wait",
    description:
      "Wait without polling for a message from the parent session. " +
      "Call this after subagent_send when you need a reply before completing your task; ending your turn without waiting completes and closes your agent.",
    parameters: Type.Object({ timeoutSeconds: waitTimeoutParameter(MAX_WAIT_SECONDS) }),
    async execute(_callId, { timeoutSeconds }, signal) {
      const outcome = await inbox.wait(timeoutSeconds, signal);
      return {
        content: [{ type: "text", text: formatWaitOutcome(outcome) }],
        details: outcome,
      };
    },
  });

  // CLI --tools is also a registration whitelist. Restore model exposure only
  // after registration, before the first prompt and its extension hooks are built.
  pi.on("session_start", (_event, ctx) => {
    session = ctx;
    pi.setActiveTools(config.activeTools);
  });
  pi.on("session_shutdown", () => {
    closing = true;
    rejectPendingRequests("Child session shut down.");
    inbox.clear();
    process.channel?.unref();
  });

  let requests = 0;
  let tokens = 0;
  let limited = false;
  let lastAssistantText: string | undefined;
  let totalToolCalls = 0;
  const activity: { id: string; summary: string; state: ToolActivityState }[] = [];
  let lastOutcome:
    | { status: "completed"; report: string }
    | { status: "limit_reached"; headline: string }
    | { status: "failed"; headline: string }
    | undefined;

  const currentProgress = (): Progress => {
    const partial = formatPartialProgress(lastAssistantText, activity, totalToolCalls);
    return partial ? { requests, tokens, partial } : { requests, tokens };
  };

  const sendProgress = () => {
    send({ type: "progress", progress: currentProgress() });
  };

  pi.on("before_agent_start", async (event, ctx) => {
    const active = new Set(pi.getActiveTools());
    if (!prepared) {
      const available = new Set(
        pi
          .getAllTools()
          .filter(
            (tool) =>
              tool.exposure === "codemode" ||
              tool.exposure === "deferred" ||
              (tool.exposure !== "hidden" && active.has(tool.name)),
          )
          .map((tool) => tool.name),
      );
      const missing = config.requiredTools.filter((tool) => !available.has(tool));
      if (
        ctx.model?.provider !== config.provider ||
        ctx.model.id !== config.model ||
        (config.modelConfig &&
          (ctx.model.api !== config.modelConfig.api ||
            ctx.model.baseUrl !== config.modelConfig.baseUrl)) ||
        missing.length
      ) {
        closing = true;
        send({
          type: "startup_error",
          error: `Child environment unavailable: model ${config.provider}/${config.model}; missing tools: ${missing.join(", ") || "none"}.`,
        });
        ctx.abort();
        throw new Error("Child model or required tools are unavailable; no fallback is allowed.");
      }
      prepared = true;
      send({ type: "ready" });
      await run;
    }
    const canCommunicate = [...COMMUNICATION_TOOLS].some((name) => active.has(name));
    return {
      systemPrompt: `${event.systemPrompt}\n\n${childInstructions(config.id, canCommunicate, config.role, config.instructions)}`,
    };
  });

  pi.on("turn_start", (_event, ctx) => {
    // Pi still announces the turn that follows a tool interrupted by an abort; that turn
    // never reaches the model.
    if (ctx.signal?.aborted) return;
    if (requests >= config.maxRequests) {
      limited = true;
      closing = true;
      ctx.abort();
    } else {
      requests++;
      sendProgress();
    }
  });

  pi.on("tool_execution_start", (event) => {
    totalToolCalls++;
    activity.push({
      id: event.toolCallId,
      summary: summarizeToolCall(event.toolName, event.args),
      state: "running",
    });
    if (activity.length > MAX_ACTIVITY_ENTRIES) activity.shift();
    sendProgress();
  });

  pi.on("tool_execution_end", (event) => {
    for (let index = activity.length - 1; index >= 0; index--) {
      const entry = activity[index];
      if (entry?.id === event.toolCallId) {
        entry.state = event.isError ? "error" : "ok";
        break;
      }
    }
    sendProgress();
  });

  pi.on("message_end", (event) => {
    if (
      event.message.role === "custom" &&
      event.message.customType === MESSAGE_TYPE &&
      record(event.message.details) &&
      typeof event.message.details.id === "string"
    ) {
      inbox.markMessageCommitted(event.message.details.id);
      return;
    }
    if (event.message.role !== "assistant") return;
    const message = event.message;
    tokens += message.usage.totalTokens;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const trimmedText = text.trim();
    if (trimmedText && (message.stopReason !== "aborted" || lastAssistantText === undefined)) {
      lastAssistantText = bounded(trimmedText, MAX_PARTIAL_TEXT_BYTES);
    }
    if (message.stopReason === "stop" && trimmedText.length > 0) {
      lastOutcome = { status: "completed", report: bounded(text) };
    } else if (message.stopReason === "length") {
      lastOutcome = {
        status: "limit_reached",
        headline: "Response token limit reached (stop reason: length).",
      };
    } else {
      lastOutcome = {
        status: "failed",
        headline: message.errorMessage || `No final answer (stop reason: ${message.stopReason}).`,
      };
    }
    sendProgress();
  });

  pi.on("agent_settled", (event) => {
    closing = true;
    inbox.clear();
    const partial = formatPartialProgress(lastAssistantText, activity, totalToolCalls);
    let result: Result;
    if (limited) {
      result = {
        status: "limit_reached",
        report: formatIncompleteReport("Model request limit reached.", partial),
        requests,
        tokens,
      };
    } else if (event.aborted) {
      result = {
        status: "cancelled",
        report: formatIncompleteReport("Child run aborted.", partial),
        requests,
        tokens,
      };
    } else if (lastOutcome?.status === "completed") {
      result = {
        status: "completed",
        report: lastOutcome.report,
        requests,
        tokens,
      };
    } else {
      result = {
        status: lastOutcome?.status ?? "failed",
        report: formatIncompleteReport(
          lastOutcome?.headline ?? "No final assistant response.",
          partial,
        ),
        requests,
        tokens,
      };
    }
    send({ type: "result", result });
  });
}
