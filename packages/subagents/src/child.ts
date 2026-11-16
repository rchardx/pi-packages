import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bounded,
  CHILD_ENV,
  CHILD_INSTRUCTIONS,
  MAX_REQUESTS,
  record,
  type Result,
} from "./protocol.ts";

/** Loaded only in the managed CLI process; IPC is separate from extension stdout. */
export default async function child(pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] !== "1" || !process.send) {
    throw new Error("The subagent child extension requires a managed IPC process.");
  }
  // Install before waiting for configuration so startup cannot outlive its owner.
  process.on("disconnect", () => process.kill(process.pid, "SIGTERM"));
  const send = (message: unknown) => {
    if (process.connected) process.send?.(message, () => {});
  };
  let release: (() => void) | undefined;
  const run = new Promise<void>((resolve) => {
    release = resolve;
  });
  const config = await new Promise<{
    requiredTools: string[];
    activeTools: string[];
    provider: string;
    model: string;
    modelConfig: { api: string; baseUrl: string } | undefined;
    maxRequests: number;
  }>((resolve) => {
    process.on("message", (message: unknown) => {
      if (!record(message)) return;
      if (message.type === "run") release?.();
      if (
        message.type === "configure" &&
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
    });
    send({ type: "hello" });
  });
  // CLI --tools is also a registration whitelist. Restore model exposure only
  // after registration, before the first prompt and its extension hooks are built.
  pi.on("session_start", () => {
    pi.setActiveTools(config.activeTools);
  });
  pi.on("session_shutdown", () => {
    process.channel?.unref();
  });
  let prepared = false;
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
    if (!prepared) {
      const active = new Set(pi.getActiveTools());
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
    return { systemPrompt: `${event.systemPrompt}\n\n${CHILD_INSTRUCTIONS}` };
  });
  pi.on("turn_start", (_event, ctx) => {
    if (requests >= config.maxRequests) {
      limited = true;
      ctx.abort();
    } else {
      requests++;
    }
  });
  pi.on("message_end", (event) => {
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
