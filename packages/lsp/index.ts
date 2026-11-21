import {
  type ExtensionAPI,
  isEditToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { LspManager } from "./src/manager.ts";
import { renderLspCall, renderLspResult } from "./src/render.ts";
import { LspOutputSchema, LspParameters } from "./src/schema.ts";

export default function lspExtension(pi: ExtensionAPI) {
  const manager = new LspManager();

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // An invalid lsp.json is reported once here (and on /lsp reset); edits stay silent and lsp calls report it again.
  pi.on("session_start", async (_event, ctx) => {
    try {
      await manager.getConfig();
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  });

  pi.on("session_shutdown", () => manager.shutdownAll());

  pi.registerCommand("lsp", {
    description: "Show running language servers (or reset)",
    getArgumentCompletions: (prefix) =>
      "reset".startsWith(prefix.trimStart())
        ? [
            {
              value: "reset",
              label: "reset",
              description: "Stop running servers, clear cached failures, and reload lsp.json",
            },
          ]
        : null,
    handler: async (args, ctx) => {
      const sub = args.trim();
      if (sub === "reset") {
        try {
          await manager.reset();
          ctx.ui.notify("LSP reset · configuration reloaded.", "info");
        } catch (error) {
          ctx.ui.notify(errorMessage(error), "error");
        }
        return;
      }
      if (sub !== "") {
        ctx.ui.notify("Usage: /lsp [reset]", "error");
        return;
      }
      try {
        await manager.getConfig();
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }
      const { servers, unavailable } = manager.snapshot();
      const rows = [
        ...servers.map((server) => {
          const files = server.openFiles === 1 ? "1 open file" : `${server.openFiles} open files`;
          return `- ${server.id} (${server.workspaceRoot}) · ${files}`;
        }),
        ...unavailable.map((reason) => `- ${reason}`),
      ];
      ctx.ui.notify(
        rows.length > 0
          ? `LSP · ${servers.length} running\n\n${rows.join("\n")}`
          : "No language servers running (started on first use of a matching file).",
        "info",
      );
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return undefined;
    const path = event.input.path;
    if (typeof path !== "string") return undefined;

    const diagnostics = await manager.checkFileAfterEdit(
      path,
      ctx.cwd,
      ctx.isProjectTrusted(),
      ctx.signal,
    );
    if (!diagnostics) return undefined;
    return {
      content: [...event.content, { type: "text", text: `\n${diagnostics}` }],
      // Replacing content drops structured content unless it is passed through.
      ...(event.structuredContent !== undefined
        ? { structuredContent: event.structuredContent }
        : {}),
    };
  });

  pi.registerTool({
    name: "lsp",
    label: "lsp",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Ask a local language server about one file: its diagnostics, or the definition, references, or hover type of a symbol.",
    promptSnippet:
      "Query a language server for a file's diagnostics or a symbol's definition, references, or type",
    promptGuidelines: [
      "Successful edit and write calls append the file's errors and warnings when a language server reports them in time; use lsp diagnostics to check a file again.",
      "Use lsp definition, references, and hover for one symbol when text search is ambiguous; search and whole-project checks stay with grep and the project's compiler.",
    ],
    parameters: LspParameters,
    outputSchema: LspOutputSchema,
    renderCall: renderLspCall,
    renderResult: renderLspResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { text, structuredContent } = await manager.executeResult(
        params,
        ctx.cwd,
        ctx.isProjectTrusted(),
        signal,
      );
      return { content: [{ type: "text", text }], details: undefined, structuredContent };
    },
  });
}
