import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type Static, type TUnsafe, Type } from "typebox";

export const LSP_ACTIONS = ["diagnostics", "definition", "references", "hover"] as const;
export type LspAction = (typeof LSP_ACTIONS)[number];

function stringEnum<const T extends readonly string[]>(
  values: T,
  description?: string,
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(description !== undefined ? { description } : {}),
  });
}

export const LspParameters = Type.Object(
  {
    action: stringEnum(LSP_ACTIONS, "Read-only LSP operation to run on one file."),
    path: Type.String({ minLength: 1, description: "Target file path." }),
    line: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "1-indexed line number (required for definition, references, and hover).",
      }),
    ),
    symbol: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Identifier or text on line used to locate the target column (supports name#N for the Nth match on that line).",
      }),
    ),
  },
  { additionalProperties: false },
);

export type LspInput = Static<typeof LspParameters>;

const LspDiagnosticItem = Type.Object(
  {
    line: Type.Integer({ minimum: 1 }),
    column: Type.Integer({ minimum: 1 }),
    severity: stringEnum(["error", "warning"] as const),
    code: Type.Optional(Type.String()),
    message: Type.String(),
  },
  { additionalProperties: false },
);

const LspLocationItem = Type.Object(
  {
    path: Type.String(),
    line: Type.Integer({ minimum: 1 }),
    column: Type.Integer({ minimum: 1 }),
    preview: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LspOutputSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("unavailable"),
      reason: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("ok"),
      action: Type.Literal("diagnostics"),
      server: Type.String(),
      path: Type.String(),
      errorCount: Type.Integer({ minimum: 0 }),
      warningCount: Type.Integer({ minimum: 0 }),
      truncated: Type.Boolean(),
      diagnostics: Type.Array(LspDiagnosticItem),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("ok"),
      action: stringEnum(["definition", "references"] as const),
      server: Type.String(),
      totalCount: Type.Integer({ minimum: 0 }),
      truncated: Type.Boolean(),
      locations: Type.Array(LspLocationItem),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("ok"),
      action: Type.Literal("hover"),
      server: Type.String(),
      path: Type.String(),
      line: Type.Integer({ minimum: 1 }),
      contents: Type.Union([Type.String(), Type.Null()]),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export type LspOutput = Static<typeof LspOutputSchema>;

/** Strip terminal escape sequences and control characters before UI display. */
export function sanitizeDisplayText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\p{Cc}]/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}

/** Collapse whitespace into a single trimmed display line. */
export function singleLine(value: string): string {
  return sanitizeDisplayText(value).replace(/\s+/gu, " ").trim();
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

/** Resolve a model-provided file path (leading @, ~/, and file:// URLs included). */
export function resolveInputPath(rawPath: string, cwd: string): string {
  // Mirrors Pi's `resolveToCwd` for built-in file tools (not exported by Pi), so a path that
  // `edit` or `write` accepted names the same file here.
  let path = rawPath.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) {
    path = path.slice(1);
  }
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  if (path.startsWith("file://")) {
    return fileURLToPath(path);
  }
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function isSubpath(parentDir: string, targetPath: string): boolean {
  const rel = relative(parentDir, targetPath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function displayRelativePath(filePath: string, cwd: string): string {
  const rel = relative(cwd, filePath);
  if (!rel) return ".";
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    return rel;
  }
  return filePath;
}

const BARE_IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$_]*$/u;

function findOccurrences(
  lineText: string,
  needle: string,
  wordBoundary: boolean,
  caseSensitive: boolean,
): number[] {
  const haystack = caseSensitive ? lineText : lineText.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  if (!target) return [];
  const indices: number[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - target.length) {
    const found = haystack.indexOf(target, cursor);
    if (found === -1) break;
    if (wordBoundary) {
      const before = found > 0 ? lineText[found - 1] : "";
      const after = found + target.length < lineText.length ? lineText[found + target.length] : "";
      const beforeIdent = before ? /[\p{ID_Continue}$_]/u.test(before) : false;
      const afterIdent = after ? /[\p{ID_Continue}$_]/u.test(after) : false;
      if (!beforeIdent && !afterIdent) {
        indices.push(found);
      }
    } else {
      indices.push(found);
    }
    cursor = found + 1;
  }
  return indices;
}

/**
 * Resolve a 0-based UTF-16 character column on a single line.
 * Supports `symbol#N` (1-indexed occurrence) or defaults to the first non-whitespace character.
 */
export function resolveSymbolColumn(
  lineText: string,
  lineNumber: number,
  rawSymbol?: string,
): number {
  if (rawSymbol === undefined) {
    const firstNonSpace = lineText.search(/\S/u);
    return firstNonSpace === -1 ? 0 : firstNonSpace;
  }

  let needle = rawSymbol;
  let occurrence = 1;
  const hashMatch = /^(.*)#([1-9]\d*)$/u.exec(rawSymbol);
  if (hashMatch?.[1]) {
    needle = hashMatch[1];
    occurrence = Number.parseInt(hashMatch[2] ?? "1", 10);
  }

  const isIdent = BARE_IDENTIFIER.test(needle);
  let matches = findOccurrences(lineText, needle, isIdent, true);
  if (matches.length === 0) {
    matches = findOccurrences(lineText, needle, isIdent, false);
  }
  if (matches.length === 0 && isIdent) {
    matches = findOccurrences(lineText, needle, false, true);
  }
  const chosen = matches[occurrence - 1];
  if (chosen === undefined) {
    const preview = singleLine(lineText).slice(0, 120);
    throw new Error(
      matches.length === 0
        ? `Symbol "${needle}" not found on line ${lineNumber}${preview ? ` (${preview})` : ""}.`
        : `Symbol "${needle}" has only ${matches.length} match(es) on line ${lineNumber}, requested #${occurrence}.`,
    );
  }
  return chosen;
}
