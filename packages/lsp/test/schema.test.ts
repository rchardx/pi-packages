import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
  displayRelativePath,
  isSubpath,
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
