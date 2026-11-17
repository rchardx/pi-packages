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

const CHILD_ID = "ebb6911b-2339-4d69-9a4b-25270d2c1ebf";
const PEER_B = "11111111-2222-4333-8444-555555555555";
const PEER_C = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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
  directory = await mkdtemp(join(tmpdir(), "pi-subagents-render-"));
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

function card(name: string, args: unknown = {}) {
  const definition = tools.get(name);
  assert.ok(definition?.renderCall, `missing renderCall for ${name}`);
  assert.ok(definition.renderResult, `missing renderResult for ${name}`);
  return new ToolExecutionComponent(
    name,
    "render-fixture",
    args,
    { outputPad: 0 },
    definition,
    ui,
    directory,
  );
}

/** Return interior card rows (preserving internal blank spacer lines) inside ToolExecutionComponent's outer Spacer(1) + Box(0, 1). */
function lines(component: ToolExecutionComponent, expanded = false, width = 120) {
  component.setExpanded(expanded);
  const raw = component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
  assert.equal(raw[0], "");
  assert.equal(raw[1], "");
  assert.equal(raw.at(-1), "");
  return raw.slice(2, -1);
}

test("subagent card renders lowercase header, role badge, two-line collapsed summary, and Markdown task on expand", () => {
  const component = card("subagent", {});
  assert.deepEqual(lines(component), ["subagent"]);

  const task = "## Review scope\n\nCheck **pricing.py** against `main`.";
  component.updateArgs({ task, role: "explorer" });
  component.setArgsComplete();
  component.markExecutionStarted();
  assert.deepEqual(lines(component), [
    "subagent (explorer)  ## Review scope Check **pricing.py** against `main`.",
  ]);

  component.updateResult({
    content: [{ type: "text", text: `Started subagent ${CHILD_ID} (role: explorer).` }],
    details: { id: CHILD_ID, role: "explorer" },
    isError: false,
    durationMs: 300,
  });
  assert.deepEqual(lines(component), [
    "subagent (explorer)  ## Review scope Check **pricing.py** against `main`.",
    "Started ebb6911b · 0.3s · alt+o to expand",
  ]);
  assert.deepEqual(lines(component, true), [
    "subagent (explorer)  ## Review scope Check **pricing.py** against `main`.",
    `Started ${CHILD_ID} · 0.3s · alt+o to collapse`,
    "",
    "Review scope",
    "",
    "Check pricing.py against main.",
  ]);
});

test("subagent_send, subagent_list, subagent_wait, and subagent_cancel render exact row layouts", () => {
  const sendCard = card("subagent_send", {
    to: CHILD_ID,
    message: "## Update\n\nUse port **9090**.",
  });
  sendCard.updateResult({
    content: [{ type: "text", text: "Queued." }],
    details: {
      id: "msg-1",
      from: "main",
      to: CHILD_ID,
      broadcast: false,
      delivered: [CHILD_ID],
      skipped: [],
    },
    isError: false,
    durationMs: 100,
  });
  assert.deepEqual(lines(sendCard), [
    "subagent_send → ebb6911b  ## Update Use port **9090**.",
    "Queued for ebb6911b · 0.1s · alt+o to expand",
  ]);
  assert.deepEqual(lines(sendCard, true), [
    "subagent_send → ebb6911b  ## Update Use port **9090**.",
    `main → ${CHILD_ID} · queued · 0.1s · alt+o to collapse`,
    "",
    "Update",
    "",
    "Use port 9090.",
  ]);

  const broadcastCard = card("subagent_send", { to: "*", message: "Ping **peers**" });
  broadcastCard.updateResult({
    content: [{ type: "text", text: "Broadcast." }],
    details: {
      id: "msg-2",
      from: "main",
      to: "*",
      broadcast: true,
      delivered: [CHILD_ID],
      skipped: [
        { id: PEER_B, reason: "queue full" },
        { id: PEER_C, reason: "finished" },
      ],
    },
    isError: false,
    durationMs: 0,
  });
  assert.deepEqual(lines(broadcastCard), [
    "subagent_send → *  Ping **peers**",
    "Broadcast 1/3 peers · 0.0s · alt+o to expand",
    "Skipped 2 peer(s).",
  ]);
  assert.deepEqual(lines(broadcastCard, true), [
    "subagent_send → *  Ping **peers**",
    "Broadcast 1/3 peers · 0.0s · alt+o to collapse",
    `- ${PEER_B}: skipped (queue full)`,
    `- ${PEER_C}: skipped (finished)`,
    "",
    "Ping peers",
  ]);

  const listCard = card("subagent_list", {});
  listCard.updateResult({
    content: [{ type: "text", text: "Live agents" }],
    details: {
      agents: [
        { id: "main", self: true },
        { id: CHILD_ID, self: false, role: "explorer", elapsedMs: 12_000, task: "Inspect repo" },
      ],
    },
    isError: false,
  });
  assert.deepEqual(lines(listCard), ["subagent_list", "2 live agents · alt+o to expand"]);
  assert.deepEqual(lines(listCard, true), [
    "subagent_list",
    "2 live agents · alt+o to collapse",
    "",
    "- main (self)",
    `- ${CHILD_ID} · explorer · 12s · Inspect repo`,
  ]);

  const waitCard = card("subagent_wait", { timeoutSeconds: 120 });
  assert.deepEqual(lines(waitCard), ["subagent_wait  120s"]);
  waitCard.updateResult({
    content: [{ type: "text", text: "Incoming update queued." }],
    details: { outcome: "woke", waitedMs: 4_000 },
    isError: false,
  });
  assert.deepEqual(lines(waitCard), ["subagent_wait  120s", "Update queued · 4s"]);

  const cancelCard = card("subagent_cancel", { id: CHILD_ID });
  cancelCard.updateResult({
    content: [{ type: "text", text: "Cancelled." }],
    details: {
      id: CHILD_ID,
      status: "cancelled",
      report: "Stopped **before** completion.",
      requests: 2,
      tokens: 180,
    },
    isError: false,
    durationMs: 200,
  });
  assert.deepEqual(lines(cancelCard), [
    "subagent_cancel  ebb6911b",
    "cancelled · 2 requests · 180 tokens · 0.2s · alt+o to expand",
  ]);
  assert.deepEqual(lines(cancelCard, true), [
    "subagent_cancel  ebb6911b",
    `${CHILD_ID} · cancelled · 2 requests · 180 tokens · 0.2s · alt+o to collapse`,
    "",
    "Stopped before completion.",
  ]);
});

test("subagent tool cards strip terminal escapes on unvalidated call args and results, surface errors, and fit narrow Unicode widths", () => {
  const payload = "check\x1b[2J\x1b]52;c;YQ==\x07\x00\x07中文路径";
  const component = card("subagent", { task: payload, role: payload });
  component.updateResult({
    content: [{ type: "text", text: `Started subagent ${CHILD_ID}.` }],
    details: { id: CHILD_ID },
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
    content: [{ type: "text", text: 'Unknown subagent role "bad".' }],
    isError: true,
  });
  assert.deepEqual(lines(component), [
    "subagent (check中文路径)  check中文路径",
    'Unknown subagent role "bad".',
  ]);
});
