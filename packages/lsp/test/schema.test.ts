import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  displayRelativePath,
  isSubpath,
  LspOutputSchema,
  LspParameters,
  resolveInputPath,
  resolveSymbolColumn,
} from "../src/schema.ts";

test("LspParameters accept four single-file actions and reject anything else", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(LspParameters.properties.action)), {
    type: "string",
    enum: ["diagnostics", "definition", "references", "hover"],
    description: "Read-only LSP operation to run on one file.",
  });
  assert.deepEqual(LspParameters.required, ["action", "path"]);

  assert.equal(Check(LspParameters, { action: "diagnostics", path: "src/index.ts" }), true);
  assert.equal(
    Check(LspParameters, {
      action: "definition",
      path: "src/index.ts",
      line: 10,
      symbol: "createClient#2",
    }),
    true,
  );
  assert.equal(Check(LspParameters, { action: "diagnostics" }), false);
  assert.equal(Check(LspParameters, { action: "symbols", path: "src/index.ts" }), false);
  assert.equal(Check(LspParameters, { action: "hover", path: "a.ts", line: 0 }), false);
  assert.equal(Check(LspParameters, { action: "hover", path: "a.ts", query: "x" }), false);
});

test("resolveInputPath, isSubpath, and displayRelativePath handle @, ~, and ..foo filenames", () => {
  assert.equal(resolveInputPath("@src/index.ts", "/workspace/app"), "/workspace/app/src/index.ts");
  assert.equal(
    resolveInputPath("~/project/a.ts", "/workspace/app"),
    join(homedir(), "project/a.ts"),
  );
  assert.equal(resolveInputPath("/abs/b.ts", "/workspace/app"), "/abs/b.ts");
  // Same rules as Pi's built-in file tools: file URLs, Unicode spaces, and no trimming
  assert.equal(resolveInputPath("file:///abs/my%20file.ts", "/workspace/app"), "/abs/my file.ts");
  assert.equal(resolveInputPath("a\u00A0b.ts", "/workspace/app"), "/workspace/app/a b.ts");
  assert.equal(resolveInputPath(" a.ts", "/workspace/app"), "/workspace/app/ a.ts");

  assert.equal(isSubpath("/workspace/app", "/workspace/app"), true);
  assert.equal(isSubpath("/workspace/app", "/workspace/app/..foo.ts"), true);
  assert.equal(isSubpath("/workspace/app", "/workspace/other/a.ts"), false);
  assert.equal(isSubpath("/workspace/app", "/workspace"), false);

  assert.equal(displayRelativePath("/workspace/app/..foo.ts", "/workspace/app"), "..foo.ts");
  assert.equal(
    displayRelativePath("/workspace/other/a.ts", "/workspace/app"),
    "/workspace/other/a.ts",
  );
});

test("resolveSymbolColumn handles word boundaries, #N selectors, Unicode UTF-16 columns, and clear errors", () => {
  const line = "  const value = computeValue(value, other_value);";
  assert.equal(resolveSymbolColumn(line, 4), 2);
  assert.equal(resolveSymbolColumn(line, 4, "value"), 8);
  assert.equal(resolveSymbolColumn(line, 4, "value#2"), 29);
  assert.equal(resolveSymbolColumn(line, 4, "COMPUTEVALUE"), 16);

  // Emoji uses 2 UTF-16 code units, matching LSP Position.character semantics
  const emojiLine = 'const tag = "👩‍💻"; runCheck();';
  assert.equal(resolveSymbolColumn(emojiLine, 1, "runCheck"), emojiLine.indexOf("runCheck"));

  assert.throws(
    () => resolveSymbolColumn(line, 4, "value#3"),
    /only 2 match\(es\) on line 4, requested #3/u,
  );
  assert.throws(
    () => resolveSymbolColumn(line, 4, "missingIdent"),
    /Symbol "missingIdent" not found on line 4/u,
  );
});

test("LspOutputSchema validates unavailable and per-action ok shapes without extra fields", () => {
  for (const valid of [
    { status: "unavailable", reason: "No language server is configured." },
    {
      status: "ok",
      action: "diagnostics",
      server: "typescript",
      path: "src/a.ts",
      errorCount: 1,
      warningCount: 0,
      truncated: false,
      diagnostics: [{ line: 2, column: 5, severity: "error", code: "TS2322", message: "Bad type" }],
    },
    {
      status: "ok",
      action: "references",
      server: "typescript",
      totalCount: 1,
      truncated: false,
      locations: [{ path: "src/a.ts", line: 1, column: 10, preview: "export const a = 1;" }],
    },
    {
      status: "ok",
      action: "hover",
      server: "typescript",
      path: "src/a.ts",
      line: 1,
      contents: null,
      truncated: false,
    },
  ]) {
    assert.equal(Check(LspOutputSchema, valid), true, JSON.stringify(valid));
  }

  for (const invalid of [
    { status: "unavailable" },
    { status: "ok", action: "diagnostics", server: "typescript" },
    {
      status: "ok",
      action: "diagnostics",
      server: "typescript",
      path: "src/a.ts",
      errorCount: 0,
      warningCount: 0,
      truncated: false,
      diagnostics: [{ line: 1, column: 1, severity: "hint", message: "Filtered out" }],
    },
    {
      status: "ok",
      action: "hover",
      server: "typescript",
      path: "src/a.ts",
      line: 1,
      contents: "type x = number",
      truncated: false,
      extra: true,
    },
  ]) {
    assert.equal(Check(LspOutputSchema, invalid), false, JSON.stringify(invalid));
  }
});
