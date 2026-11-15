import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const TextRange = Type.Object({
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 0 }),
});
const DisplaySection = Type.Object({
  heading: TextRange,
  url: Type.Optional(TextRange),
  metadata: Type.Array(TextRange),
  body: Type.Array(TextRange),
});
export const Display = Type.Object({
  previewLength: Type.Integer({ minimum: 0 }),
  sections: Type.Array(DisplaySection),
});

// Presentation refers to the same text sent to the model, without duplicating page bodies
// in session details or parsing provider content for delimiters.
export class FormattedOutput {
  text = "";
  sections: Static<typeof DisplaySection>[] = [];

  append(value: string): Static<typeof TextRange> {
    const start = this.text.length;
    this.text += value;
    return { start, end: this.text.length };
  }
}

export function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export async function prepareOutput(
  output: FormattedOutput,
  kind: "fetch" | "search",
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const preview = truncateHead(output.text);
  let fullOutputPath: string | undefined;
  let text = preview.content;
  if (preview.truncated) {
    const directory = await mkdtemp(join(tmpdir(), `pi-web-${kind}-`));
    fullOutputPath = join(directory, "content.txt");
    try {
      await writeFile(fullOutputPath, output.text, {
        encoding: "utf8",
        mode: 0o600,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const label = kind === "fetch" ? "Full fetched content" : "Full search results";
    text += `\n\n[Output truncated. ${label} saved to: ${fullOutputPath}. Use read with offset/limit to continue.]`;
  }
  return {
    content: [{ type: "text" as const, text }],
    details: {
      truncated: preview.truncated,
      display: { previewLength: preview.content.length, sections: output.sections },
      ...(fullOutputPath ? { fullOutputPath } : {}),
    },
  };
}
