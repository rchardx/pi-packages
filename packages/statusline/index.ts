import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStatuslineFooter } from "./src/footer.ts";

export default function statusline(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) =>
      createStatuslineFooter(pi, ctx, tui, theme, footerData),
    );
  });
}
