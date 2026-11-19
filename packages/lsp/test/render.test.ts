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
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";

const tools = new Map<string, ToolDefinition>();
const terminal: Terminal = {
  columns: 120,
  rows: 40,
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
  directory = await mkdtemp(join(tmpdir(), "pi-lsp-render-"));
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
  const definition = tools.get("lsp");
  assert.ok(definition?.renderCall);
  assert.ok(definition.renderResult);
  return new ToolExecutionComponent(
    "lsp",
    "call-1",
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

test("lsp card shows the result's first line collapsed and the whole text expanded", () => {
  const component = card({});
  assert.deepEqual(lines(component), ["lsp"]);

  component.updateArgs({ action: "references", path: "src/index.ts", line: 8, symbol: "add" });
  component.setArgsComplete();
  component.markExecutionStarted();
  assert.deepEqual(lines(component), ["lsp (references)  src/index.ts:8 · add"]);

  // A one-line result has nothing to expand
  component.updateResult({
    content: [{ type: "text", text: "No references found (typescript)" }],
    details: undefined,
    isError: false,
    durationMs: 120,
  });
  assert.deepEqual(lines(component), [
    "lsp (references)  src/index.ts:8 · add",
    "No references found (typescript) · 0.1s",
  ]);
  assert.deepEqual(lines(component, true), lines(component));

  component.updateResult({
    content: [
      {
        type: "text",
        text: "2 references (typescript)\n- src/a.ts:1:17  export function add() {}\n- src/b.ts:2:14  add();",
      },
    ],
    details: undefined,
    isError: false,
    durationMs: 1_240,
  });
  assert.deepEqual(lines(component), [
    "lsp (references)  src/index.ts:8 · add",
    "2 references (typescript) · 1.2s · alt+o to expand",
  ]);
  assert.deepEqual(lines(component, true), [
    "lsp (references)  src/index.ts:8 · add",
    "2 references (typescript) · 1.2s · alt+o to collapse",
    "",
    "- src/a.ts:1:17  export function add() {}",
    "- src/b.ts:2:14  add();",
  ]);

  component.updateResult({
    content: [{ type: "text", text: '"line" is required for references.' }],
    details: undefined,
    isError: true,
  });
  assert.deepEqual(lines(component), [
    "lsp (references)  src/index.ts:8 · add",
    '"line" is required for references.',
  ]);
});

test("lsp card strips terminal escape sequences and fits narrow Unicode widths", () => {
  const payload = "bad\x1b[2J\x1b]52;c;YQ==\x07\x00\x07中文路径.ts";
  const component = card({ action: "diagnostics", path: payload, symbol: payload });
  component.updateResult({
    content: [
      { type: "text", text: `${payload}: 1 error (ts)\n- ${payload}:1:1 [error] 第二行👩‍💻` },
    ],
    details: undefined,
    isError: false,
  });

  for (const width of [20, 40, 80]) {
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      const rendered = component.render(width);
      assert.ok(rendered.every((line) => visibleWidth(line) <= width));
      const raw = rendered.join("\n");
      for (const seq of ["\x1b[2J", "\x1b]52;", "\x00", "\x07"]) {
        assert.ok(!raw.includes(seq));
      }
    }
  }
});
