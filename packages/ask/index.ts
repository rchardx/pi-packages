import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderAskCall, renderAskResult } from "./src/render.ts";
import { runRpcAsk } from "./src/rpc.ts";
import {
  type AskDetails,
  AskParameters,
  formatAskOutput,
  normalizeQuestions,
} from "./src/schema.ts";
import { runTuiAsk } from "./src/tui.ts";

const TOOL_NAME = "ask";

function isInteractiveHostMode(mode: ExtensionContext["mode"]): boolean {
  return mode === "tui" || mode === "rpc";
}

export default function askExtension(pi: ExtensionAPI) {
  let interactiveAvailable = false;

  pi.on("session_start", (_event, ctx) => {
    interactiveAvailable = isInteractiveHostMode(ctx.mode);
    // createAgentSession evaluates prepareLoadout before bindExtensions sets ctx.mode;
    // re-apply active tools so session.systemPrompt and before_agent_start reflect the bound mode.
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME)) {
      pi.setActiveTools(active);
    }
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_NAME,
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Ask the user 1–4 structured multiple-choice questions and return their selected or custom answers. " +
      'Each question provides 2–5 distinct options and automatically includes an "Other…" free-text input.',
    promptSnippet: "Ask the user structured multiple-choice clarification questions",
    promptGuidelines: [
      "Use ask only when requirements, trade-offs, or destructive actions remain genuinely ambiguous after inspecting relevant project files.",
      'Batch related clarifications into one ask call, put the recommended option first when applicable, and omit catch-all "Other" options.',
    ],
    parameters: AskParameters,
    prepareLoadout() {
      return interactiveAvailable ? undefined : { hiddenDeclarations: [TOOL_NAME] };
    },
    renderCall: renderAskCall,
    renderResult: renderAskResult,
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<{
      content: [{ type: "text"; text: string }];
      details: AskDetails;
    }> {
      if (!isInteractiveHostMode(ctx.mode)) {
        throw new Error(
          `User clarification via ask requires tui or rpc mode (current mode: ${ctx.mode}).`,
        );
      }
      const questions = normalizeQuestions(params.questions);
      signal?.throwIfAborted();
      const details =
        ctx.mode === "tui"
          ? await runTuiAsk(questions, ctx, signal)
          : await runRpcAsk(questions, ctx.ui, signal);
      return {
        content: [{ type: "text", text: formatAskOutput(details) }],
        details,
      };
    },
  });
}
