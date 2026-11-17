import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  DefaultResourceLoader,
  initTheme,
  SettingsManager,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  type Terminal,
  TuiMainScreen,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";

const tools = new Map<string, ToolRenderers>();
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
const ui = new TuiMainScreen(terminal);
let directory: string;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-ask-render-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  for (const extension of loader.getExtensions().extensions) {
    for (const [name, tool] of extension.tools) tools.set(name, tool.definition);
  }
  initTheme("dark");
  setKeybindings(
    new KeybindingsManager(
      {
        ...TUI_KEYBINDINGS,
        "app.tools.expand": { defaultKeys: "ctrl+o" },
      },
      { "app.tools.expand": "alt+o" },
    ),
  );
});

after(async () => {
  ui.stop();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(directory, { recursive: true, force: true });
});

function card(args: unknown = {}) {
  const definition = tools.get("ask");
  assert.ok(definition?.renderCall);
  assert.ok(definition.renderResult);
  return new ToolExecutionComponent(
    "ask",
    "render-fixture",
    args,
    { outputPad: 0 },
    definition,
    ui,
    directory,
  );
}

function lines(component: ToolExecutionComponent, expanded = false, width = 120) {
  component.setExpanded(expanded);
  const raw = component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
  assert.equal(raw[0], "");
  assert.equal(raw[1], "");
  assert.equal(raw.at(-1), "");
  return raw.slice(2, -1);
}

test("ask card renders lowercase headers during streaming, compact two-line summaries, and expanded answers", () => {
  const single = card({});
  assert.deepEqual(lines(single), ["ask"]);

  single.updateArgs({
    questions: [{ id: "auth", question: "Which\nauth flow?" }],
  });
  single.setArgsComplete();
  single.markExecutionStarted();
  assert.deepEqual(lines(single), ["ask  Which auth flow?"]);

  single.updateResult({
    content: [{ type: "text", text: "Answer (auth): Device code" }],
    details: {
      cancelled: false,
      answers: [
        {
          id: "auth",
          header: "Auth",
          question: "Which auth flow?",
          selected: ["Device code"],
        },
      ],
    },
    isError: false,
    durationMs: 1800,
  });
  assert.deepEqual(lines(single), [
    "ask  Which auth flow?",
    "Answered: Device code · 1.8s · alt+o to expand",
  ]);
  assert.deepEqual(lines(single, true), [
    "ask  Which auth flow?",
    "Answered 1 question · 1.8s · alt+o to collapse",
    "",
    "Auth — Which auth flow?",
    "  → Device code",
  ]);

  const multi = card({
    questions: [
      { id: "auth", header: "Auth", question: "Which auth?" },
      { id: "scopes", question: "Which scopes?" },
    ],
  });
  multi.updateResult({
    content: [{ type: "text", text: "Answers" }],
    details: {
      cancelled: false,
      answers: [
        {
          id: "auth",
          header: "Auth",
          question: "Which auth?",
          selected: ["Device code"],
        },
        {
          id: "scopes",
          header: "scopes",
          question: "Which scopes?",
          selected: ["read"],
          customText: "admin",
        },
      ],
    },
    isError: false,
    durationMs: 3200,
  });
  assert.deepEqual(lines(multi), [
    "ask (2 questions)  Auth · scopes",
    "Answered 2 questions · 3.2s · alt+o to expand",
  ]);
  assert.deepEqual(lines(multi, true), [
    "ask (2 questions)  Auth · scopes",
    "Answered 2 questions · 3.2s · alt+o to collapse",
    "",
    "Auth — Which auth?",
    "  → Device code",
    "scopes — Which scopes?",
    "  → read, Other: admin",
  ]);

  const cancelled = card({ questions: [{ id: "auth", question: "Which auth?" }] });
  cancelled.updateResult({
    content: [{ type: "text", text: "User cancelled the clarification prompt." }],
    details: { cancelled: true, answers: [] },
    isError: false,
    durationMs: 900,
  });
  assert.deepEqual(lines(cancelled), ["ask  Which auth?", "Cancelled · 0.9s"]);

  const longUnicodeChoice = "方案👩‍💻".repeat(12);
  const unicodeSingle = card({ questions: [{ id: "plan", question: "方案？" }] });
  unicodeSingle.updateResult({
    content: [{ type: "text", text: `Answer (plan): ${longUnicodeChoice}` }],
    details: {
      cancelled: false,
      answers: [
        {
          id: "plan",
          header: "方案",
          question: "方案？",
          selected: [longUnicodeChoice],
        },
      ],
    },
    isError: false,
    durationMs: 400,
  });
  const collapsedUnicode = lines(unicodeSingle, false, 70)[1] ?? "";
  assert.ok(!collapsedUnicode.includes("\uFFFD"), "never split surrogate pairs");
  assert.match(collapsedUnicode, / · 0\.4s · alt\+o to expand$/u);
});

test("ask card strips terminal escapes, surfaces errors, and fits narrow Unicode widths", () => {
  const payload = "check\x1b[2J\x1b]52;c;YQ==\x07\x00\x07中文问题";
  const component = card({
    questions: [{ id: "q1", header: payload, question: payload }],
  });
  component.updateResult({
    content: [{ type: "text", text: "Answer (q1): 方案一" }],
    details: {
      cancelled: false,
      answers: [
        {
          id: "q1",
          header: payload,
          question: `${payload}\n第二行`,
          selected: [payload],
        },
      ],
    },
    isError: false,
  });

  for (const width of [20, 40, 80]) {
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      const rendered = component.render(width);
      assert.ok(rendered.every((line) => visibleWidth(line) <= width));
      const raw = rendered.join("\n");
      for (const control of ["\x1b[2J", "\x1b]52;", "\x00", "\x07"]) {
        assert.ok(!raw.includes(control));
      }
    }
  }

  component.updateResult({
    content: [{ type: "text", text: 'Duplicate question id "q1".' }],
    isError: true,
  });
  assert.deepEqual(lines(component), ["ask  check中文问题", 'Duplicate question id "q1".']);
});
