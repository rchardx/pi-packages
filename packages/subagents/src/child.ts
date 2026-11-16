import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentInbox, registerCommunicationTools } from "./inbox.ts";
import { formatPeerMessage } from "./notify.ts";
import {
  bounded,
  CHILD_ENV,
  childInstructions,
  type DeliveryReceipt,
  isDeliveryReceipt,
  isLiveAgent,
  isMessageEnvelope,
  type LiveAgent,
  MAX_REQUESTS,
  MESSAGE_TYPE,
  record,
  type Result,
  validateSendInput,
} from "./protocol.ts";

const COMMUNICATION_TOOLS = new Set(["subagent_list", "subagent_send", "subagent_wait"]);

/** Loaded only in the managed CLI process; IPC is separate from extension stdout. */
export default async function child(pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] !== "1" || !process.send) {
    throw new Error("The subagent child extension requires a managed IPC process.");
  }
  const inbox = new AgentInbox();
  const pendingRequests = new Map<
    string,
    { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }
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
                content: formatPeerMessage(message.envelope),
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
        case "list_result":
        case "send_result":
          if (typeof message.requestId === "string") {
            const pending = pendingRequests.get(message.requestId);
            if (pending) {
              pendingRequests.delete(message.requestId);
              pending.resolve(message);
            }
          }
          break;
      }
    });
    send({ type: "hello" });
  });

  const requestParent = (
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    if (signal?.aborted) return Promise.reject(new Error("Operation cancelled."));
    if (!process.connected || closing) {
      return Promise.reject(new Error("Parent IPC channel disconnected."));
    }
    const requestId = randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onAbort = () => {
        if (pendingRequests.delete(requestId)) {
          reject(new Error("Operation cancelled."));
        }
      };
      pendingRequests.set(requestId, {
        resolve: (response) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      process.send?.({ ...payload, requestId }, (error) => {
        if (error && pendingRequests.delete(requestId)) {
          signal?.removeEventListener("abort", onAbort);
          reject(new Error("Child IPC request failed."));
        }
      });
    });
  };

  registerCommunicationTools(
    pi,
    {
      async list(signal): Promise<LiveAgent[]> {
        const response = await requestParent({ type: "list" }, signal);
        if (!Array.isArray(response.agents) || !response.agents.every(isLiveAgent)) {
          throw new Error("Invalid agent list response from parent session.");
        }
        return response.agents;
      },
      async send(rawTo, rawMessage, signal): Promise<DeliveryReceipt> {
        const { to, message } = validateSendInput(rawTo, rawMessage);
        const response = await requestParent({ type: "send", to, message }, signal);
        if (typeof response.error === "string") {
          throw new Error(response.error);
        }
        if (!isDeliveryReceipt(response.receipt)) {
          throw new Error("Invalid message delivery receipt from parent session.");
        }
        return response.receipt;
      },
      wait(timeoutSeconds, signal) {
        return inbox.wait(timeoutSeconds, signal);
      },
    },
    { isChild: true },
  );

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
  let final: Result = {
    status: "failed",
    report: "No final assistant response.",
    requests: 0,
    tokens: 0,
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
      systemPrompt: `${event.systemPrompt}\n\n${childInstructions(config.id, canCommunicate)}`,
    };
  });

  pi.on("turn_start", (_event, ctx) => {
    if (requests >= config.maxRequests) {
      limited = true;
      closing = true;
      ctx.abort();
    } else {
      requests++;
    }
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
    const completed = message.stopReason === "stop" && text.trim().length > 0;
    final = {
      status: completed
        ? "completed"
        : message.stopReason === "length"
          ? "limit_reached"
          : "failed",
      report: bounded(
        text || message.errorMessage || `No final answer (stop reason: ${message.stopReason}).`,
      ),
      requests,
      tokens,
    };
  });

  pi.on("agent_settled", (event) => {
    closing = true;
    inbox.clear();
    send({
      type: "result",
      result: {
        ...final,
        status: limited ? "limit_reached" : event.aborted ? "cancelled" : final.status,
        report: limited
          ? bounded(`Model request limit reached. Partial result:\n${final.report}`)
          : final.report,
        requests,
        tokens,
      },
    });
  });
}
