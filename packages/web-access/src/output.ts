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
  synthesis: Type.Optional(TextRange),
  sections: Type.Array(DisplaySection),
});

// Presentation refers to the same text sent to the model, without duplicating page bodies
// in session details or parsing provider content for delimiters.
export class FormattedOutput {
  text = "";
  synthesis?: Static<typeof TextRange>;
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

export interface PrepareOutputOptions {
  outputTokenLimitReached?: boolean;
}

export async function prepareOutput(
  output: FormattedOutput,
  kind: "fetch" | "search",
  signal?: AbortSignal,
  options: PrepareOutputOptions = {},
) {
  signal?.throwIfAborted();
  const tokenLimitNotice = options.outputTokenLimitReached
    ? kind === "fetch"
      ? "[Provider output reached the model token limit; extracted content is incomplete.]"
      : "[Provider synthesis reached the model token limit and is incomplete.]"
    : undefined;
  const fullText = tokenLimitNotice ? `${output.text}\n\n${tokenLimitNotice}` : output.text;
  const preview = truncateHead(output.text);
  let fullOutputPath: string | undefined;
  let text = preview.content;
  if (tokenLimitNotice) {
    text += `\n\n${tokenLimitNotice}`;
  }
  if (preview.truncated) {
    const directory = await mkdtemp(join(tmpdir(), `pi-web-${kind}-`));
    fullOutputPath = join(directory, "content.txt");
    try {
      await writeFile(fullOutputPath, fullText, {
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
      ...(options.outputTokenLimitReached ? { outputTokenLimitReached: true } : {}),
      display: {
        previewLength: preview.content.length,
        ...(output.synthesis ? { synthesis: output.synthesis } : {}),
        sections: output.sections,
      },
      ...(fullOutputPath ? { fullOutputPath } : {}),
    },
  };
}
