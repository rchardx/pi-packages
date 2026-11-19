import assert from "node:assert/strict";
import { before, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  Text,
  type Terminal,
  TuiMainScreen,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AskDetails, AskQuestion } from "../src/schema.ts";
import { createAskComponent } from "../src/tui.ts";

const KEY = {
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  tab: "\t",
  shiftTab: "\u001b[Z",
  enter: "\r",
  escape: "\u001b",
  space: " ",
} as const;

let activeTheme: Theme;
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

function createStubTui() {
  const terminal: Terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
    async drainInput() {},
  };
  return new TuiMainScreen(terminal);
}

before(() => {
  initTheme("dark");
  const probeUi = createStubTui();
  let captured: Theme | undefined;
  new ToolExecutionComponent(
    "probe",
    "probe-call",
    {},
    {},
    {
      renderCall(_args, theme) {
        captured = theme;
        return new Text("", 0, 0);
      },
    },
    probeUi,
    process.cwd(),
  );
  probeUi.stop();
  assert.ok(captured);
  activeTheme = captured;
});

function plainText(lines: readonly string[]): string {
  return lines
    .map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")).trimEnd())
    .join("\n");
}

test("single-select TUI question confirms preset option or custom Other input with IME cursor marker", () => {
  const questions: AskQuestion[] = [
    {
      id: "auth",
      header: "Auth",
      question: "Which auth flow?",
      options: [
        { label: "Device code", description: "Works over SSH" },
        { label: "Localhost callback" },
      ],
      multiSelect: false,
    },
  ];

  // 1. Direct preset confirmation
  const tui1 = createStubTui();
  let outcome1: AskDetails | undefined;
  const comp1 = createAskComponent(questions, tui1, activeTheme, keybindings, (res) => {
    outcome1 = res;
  });
  comp1.focused = true;
  assert.ok(
    !comp1.render(80).join("\n").includes(CURSOR_MARKER),
    "no hardware cursor in list mode",
  );
  assert.doesNotMatch(plainText(comp1.render(80)), /1\. Device code/u, "omit numeric prefixes");
  assert.match(plainText(comp1.render(80)), /❯ Device code/u);
  comp1.handleInput(KEY.down);
  comp1.handleInput(KEY.enter);
  assert.deepEqual(outcome1, {
    cancelled: false,
    answers: [
      {
        id: "auth",
        header: "Auth",
        question: "Which auth flow?",
        selected: ["Localhost callback"],
      },
    ],
  });
  tui1.stop();

  // 2. Custom Other… input with IME CURSOR_MARKER, Escape back, then custom submit
  const tui2 = createStubTui();
  let outcome2: AskDetails | undefined;
  const comp2 = createAskComponent(questions, tui2, activeTheme, keybindings, (res) => {
    outcome2 = res;
  });
  comp2.focused = true;
  comp2.handleInput(KEY.down);
  comp2.handleInput(KEY.down); // On "3. Other…"
  comp2.handleInput(KEY.enter);

  const editingRaw = comp2.render(80).join("\n");
  assert.ok(editingRaw.includes(CURSOR_MARKER), "emit CURSOR_MARKER when focused in custom input");

  // Escape exits custom input back to the option list without cancelling the whole prompt
  comp2.handleInput(KEY.escape);
  assert.equal(outcome2, undefined);
  assert.ok(!comp2.render(80).join("\n").includes(CURSOR_MARKER));

  // Re-enter Other…, type custom text, and press Enter to submit
  comp2.handleInput(KEY.enter);
  for (const ch of "Signed JWT") comp2.handleInput(ch);
  comp2.handleInput(KEY.enter);
  assert.deepEqual(outcome2, {
    cancelled: false,
    answers: [
      {
        id: "auth",
        header: "Auth",
        question: "Which auth flow?",
        selected: [],
        customText: "Signed JWT",
      },
    ],
  });
  tui2.stop();
});

test("multi-question and multi-select TUI flows support tabs, Space toggle, review jump, Escape, and AbortSignal", () => {
  const questions: AskQuestion[] = [
    {
      id: "runtime",
      header: "Runtime",
      question: "Target runtime?",
      options: [{ label: "Node 22" }, { label: "Node 26" }],
      multiSelect: false,
    },
    {
      id: "scopes",
      header: "Scopes",
      question: "Select scopes:",
      options: [{ label: "read" }, { label: "write" }, { label: "admin" }],
      multiSelect: true,
    },
  ];

  const tui = createStubTui();
  let outcome: AskDetails | undefined;
  const comp = createAskComponent(questions, tui, activeTheme, keybindings, (res) => {
    outcome = res;
  });
  comp.focused = true;

  // Jump straight to Submit tab while unanswered -> Enter jumps to first unanswered question (tab 0)
  comp.handleInput(KEY.shiftTab);
  assert.match(plainText(comp.render(80)), /Review answers[\s\S]*Runtime: \(unanswered\)/u);
  comp.handleInput(KEY.enter);
  assert.match(plainText(comp.render(80)), /Target runtime\?/u);

  // Answer Q1 -> auto-advances to Q2 (multiSelect)
  comp.handleInput(KEY.enter);
  assert.match(plainText(comp.render(80)), /Select scopes:/u);

  // Toggle "read" with Space, move to "admin" and toggle with Enter (must toggle, not prematurely submit!)
  comp.handleInput(KEY.space);
  comp.handleInput(KEY.down);
  comp.handleInput(KEY.down);
  comp.handleInput(KEY.enter);
  assert.match(plainText(comp.render(80)), /\[✓\] admin/u);
  assert.equal(outcome, undefined);
  comp.handleInput(KEY.down); // Other…
  comp.handleInput(KEY.enter);
  for (const ch of "audit:read") comp.handleInput(ch);
  comp.handleInput(KEY.enter); // Saves custom text and moves cursor to Confirm row
  comp.handleInput(KEY.enter); // Confirms Q2 on Confirm row -> advances to Submit tab

  const review = plainText(comp.render(80));
  assert.match(review, /Runtime: Node 22/u);
  assert.match(review, /Scopes: read, admin, Other: audit:read/u);

  // Final Enter on Submit tab finishes
  comp.handleInput(KEY.enter);
  assert.deepEqual(outcome, {
    cancelled: false,
    answers: [
      {
        id: "runtime",
        header: "Runtime",
        question: "Target runtime?",
        selected: ["Node 22"],
      },
      {
        id: "scopes",
        header: "Scopes",
        question: "Select scopes:",
        selected: ["read", "admin"],
        customText: "audit:read",
      },
    ],
  });
  tui.stop();

  // Escape in list mode cancels and discards partial drafts
  const tuiCancel = createStubTui();
  let cancelledOutcome: AskDetails | undefined;
  const cancelComp = createAskComponent(questions, tuiCancel, activeTheme, keybindings, (res) => {
    cancelledOutcome = res;
  });
  cancelComp.handleInput(KEY.enter); // Answer Q1
  cancelComp.handleInput(KEY.escape); // Cancel on Q2
  assert.deepEqual(cancelledOutcome, { cancelled: true, answers: [] });
  tuiCancel.stop();

  // AbortSignal immediately settles the component
  const tuiAbort = createStubTui();
  const controller = new AbortController();
  let abortedOutcome: AskDetails | undefined;
  const abortComp = createAskComponent(
    questions,
    tuiAbort,
    activeTheme,
    keybindings,
    (res) => {
      abortedOutcome = res;
    },
    controller.signal,
  );
  controller.abort();
  assert.deepEqual(abortedOutcome, { cancelled: true, answers: [] });
  abortComp.dispose();
  tuiAbort.stop();
});

test("TUI component fits narrow Unicode widths and refreshes across theme changes", () => {
  const questions: AskQuestion[] = [
    {
      id: "lang",
      header: "中文标签👩‍💻",
      question: "请选择配置方案（支持宽字符与 Emoji 👩‍💻）？",
      options: [
        { label: "方案一：增量同步", description: "低延迟，适合交互式编辑场景" },
        { label: "方案二：全量校验", description: "强一致，适合 CI 环境" },
      ],
      multiSelect: true,
    },
    {
      id: "mode",
      header: "模式",
      question: "是否开启严格校验？",
      options: [{ label: "开启" }, { label: "关闭" }],
      multiSelect: false,
    },
  ];

  const tui = createStubTui();
  const comp = createAskComponent(questions, tui, activeTheme, keybindings, () => {});
  comp.focused = true;

  const snapshots: string[] = [];
  for (const scheme of ["dark", "light"] as const) {
    initTheme(scheme);
    comp.invalidate();
    for (const width of [20, 40, 80]) {
      const rendered = comp.render(width);
      assert.ok(
        rendered.every((line) => visibleWidth(line.replaceAll(CURSOR_MARKER, "")) <= width),
        `overflowed width ${width}`,
      );
    }
    snapshots.push(comp.render(60).join("\n"));
  }
  assert.notEqual(snapshots[0], snapshots[1]);
  initTheme("dark");
  comp.dispose();
  tui.stop();
});

test("TUI component settles at most once across concurrent input and AbortSignal", () => {
  const questions: AskQuestion[] = [
    {
      id: "auth",
      header: "Auth",
      question: "Which auth flow?",
      options: [{ label: "Device code" }, { label: "Localhost callback" }],
      multiSelect: false,
    },
  ];

  // Confirm first, then abort and send extra keys -> done called once with answer
  const tui1 = createStubTui();
  const controller1 = new AbortController();
  const outcomes1: AskDetails[] = [];
  const comp1 = createAskComponent(
    questions,
    tui1,
    activeTheme,
    keybindings,
    (res) => {
      outcomes1.push(res);
    },
    controller1.signal,
  );
  comp1.handleInput(KEY.enter);
  controller1.abort();
  comp1.handleInput(KEY.escape);
  comp1.handleInput(KEY.enter);
  assert.equal(outcomes1.length, 1);
  assert.deepEqual(outcomes1[0], {
    cancelled: false,
    answers: [
      {
        id: "auth",
        header: "Auth",
        question: "Which auth flow?",
        selected: ["Device code"],
      },
    ],
  });
  comp1.dispose();
  tui1.stop();

  // Abort first, then send confirm/cancel keys -> done called once with cancellation
  const tui2 = createStubTui();
  const controller2 = new AbortController();
  const outcomes2: AskDetails[] = [];
  const comp2 = createAskComponent(
    questions,
    tui2,
    activeTheme,
    keybindings,
    (res) => {
      outcomes2.push(res);
    },
    controller2.signal,
  );
  controller2.abort();
  comp2.handleInput(KEY.enter);
  comp2.handleInput(KEY.escape);
  assert.equal(outcomes2.length, 1);
  assert.deepEqual(outcomes2[0], { cancelled: true, answers: [] });
  comp2.dispose();
  tui2.stop();
});
