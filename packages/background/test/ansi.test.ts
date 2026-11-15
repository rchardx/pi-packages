import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi } from "../src/ansi.ts";

const ESC = "\u001B";
const BEL = "\u0007";

test("stripAnsi removes CSI, OSC, and charset sequences", () => {
  assert.equal(stripAnsi("plain text"), "plain text");
  assert.equal(stripAnsi(`${ESC}[32mgreen${ESC}[0m`), "green");
  assert.equal(stripAnsi(`${ESC}[1;31mbold red${ESC}[22;39m`), "bold red");
  // OSC terminated by BEL and by ST.
  assert.equal(stripAnsi(`${ESC}]0;window title${BEL}visible`), "visible");
  assert.equal(stripAnsi(`${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`), "link");
  // Character set selection and two-byte escapes.
  assert.equal(stripAnsi(`${ESC}(0lqk${ESC}(B`), "lqk");
  assert.equal(stripAnsi(`${ESC}[?25lhidden cursor${ESC}[?25h`), "hidden cursor");
});
