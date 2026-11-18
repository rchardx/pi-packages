import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import { type Launch, record } from "../src/protocol.ts";
import { startChild } from "../src/runner.ts";

const PING = "mcp__fixture__ping";
const OTHER = "mcp__fixture__other";

function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ToolCall = { name: string; arguments: Record<string, unknown> };

interface Options {
  exposure?: "codemode" | "direct";
  toolExposure?: Record<string, "codemode" | "direct">;
  /** Tool-list responses from this request number on wait for `release`. */
  holdListsFrom: number;
  /** Scripted model: the tool to call for a request, or the final answer. */
  model(request: { child: boolean; toolResults: number; text: string }): ToolCall | string;
}

/** One local server acting as the model endpoint and as a streamable-HTTP MCP server. */
async function fixture(t: TestContext, options: Options) {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_OFFLINE: process.env.PI_OFFLINE,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_OFFLINE = "1";
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const release = latch();
  const childAsked = latch();
  const childRequests: Record<string, unknown>[] = [];
  const calls = { ping: 0, other: 0 };
  const mcpRequests = { initializes: 0, lists: 0 };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const input: unknown = JSON.parse(body);
    assert.ok(record(input));

    if (req.url === "/v1/chat/completions") {
      const messages = Array.isArray(input.messages) ? input.messages.filter(record) : [];
      const text = JSON.stringify(messages);
      const child = text.includes("Delegated task:");
      if (child) {
        childRequests.push(input);
        childAsked.resolve();
      }
      const step = options.model({
        child,
        toolResults: messages.filter((message) => message.role === "tool").length,
        text,
      });
      const delta =
        typeof step === "string"
          ? { role: "assistant", content: step }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${messages.length}`,
                  type: "function",
                  function: { name: step.name, arguments: JSON.stringify(step.arguments) },
                },
              ],
            };
      const chunk = { id: "mock", object: "chat.completion.chunk", created: 1, model: "test" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          ...chunk,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: typeof step === "string" ? "stop" : "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }

    if (input.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (input.method === "initialize") {
      mcpRequests.initializes++;
      assert.ok(record(input.params));
      result = {
        protocolVersion: input.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    } else if (input.method === "tools/list") {
      mcpRequests.lists++;
      if (mcpRequests.lists >= options.holdListsFrom) await release.promise;
      result = {
        tools: ["ping", "other"].map((name) => ({
          name,
          description: `Local ${name}`,
          inputSchema: { type: "object", properties: {} },
        })),
      };
    } else if (input.method === "tools/call") {
      assert.ok(record(input.params));
      if (input.params.name === "ping") calls.ping++;
      else calls.other++;
      result = { content: [{ type: "text", text: "PONG" }] };
    }
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    release.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: `${url}/v1`,
          api: "openai-completions",
          apiKey: "test-only",
          models: [
            {
              id: "test-model",
              name: "Test",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          url: `${url}/mcp`,
          exposure: options.exposure ?? "codemode",
          ...(options.toolExposure ? { toolExposure: options.toolExposure } : {}),
        },
      },
    }),
  );
  return { dir, release, childAsked, childRequests, calls, mcpRequests };
}

async function rpcSession(t: TestContext, dir: string, expectedReports = 1) {
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const installedRoot = join(dir, "packages", "subagents");
  await mkdir(installedRoot, { recursive: true });
  const manifest: unknown = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  assert.ok(record(manifest) && Array.isArray(manifest.files));
  for (const entry of ["package.json", ...manifest.files]) {
    assert.ok(typeof entry === "string");
    await cp(join(sourceRoot, entry), join(installedRoot, entry), { recursive: true });
  }
  const client = new RpcClient({
    cliPath: join(getPackageDir(), "dist", "bundle", "cli.js"),
    cwd: dir,
    provider: "mock",
    model: "test-model",
    args: ["--no-session", "-ns", "-np", "--no-themes", "-e", installedRoot],
  });
  t.after(() => client.stop());
  const reports: string[] = [];
  const completed = new Promise<void>((resolve, reject) => {
    client.onEvent((event) => {
      if (event.type === "tool_execution_end" && event.isError) {
        reject(new Error(`Tool failed: ${JSON.stringify(event.result)}`));
      }
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "subagent:result" &&
        typeof event.message.content === "string"
      ) {
        reports.push(event.message.content);
      }
      // A root that is still busy receives the report as an appended entry instead.
      if (
        event.type === "entry_appended" &&
        event.entry.type === "custom_message" &&
        event.entry.customType === "subagent:result" &&
        typeof event.entry.content === "string"
      ) {
        reports.push(event.entry.content);
      }
      if (event.type === "agent_settled" && reports.length >= expectedReports) resolve();
    });
  });
  await client.start();
  return { client, reports, completed };
}

const script = (code: string): ToolCall => ({ name: "codemode", arguments: { code } });

function declared(request: Record<string, unknown> | undefined): unknown[] {
  assert.ok(request);
  if (!Array.isArray(request.tools)) return [];
  return request.tools
    .filter(record)
    .map((tool) => (record(tool.function) ? tool.function.name : undefined));
}

test("a delegated child starts before its MCP servers connect and still reaches their tools", {
  timeout: 60_000,
}, async (t) => {
  const { dir, release, childAsked, childRequests, calls } = await fixture(t, {
    // The parent's server answers at once. Every later tool list belongs to the child and
    // stays unanswered until the child's model has already asked for the tool.
    holdListsFrom: 2,
    model: ({ child, toolResults }) => {
      if (toolResults === 0) return script(`text(await tools.${PING}({}));`);
      if (child) return "Child reached MCP.";
      if (toolResults === 1) {
        return { name: "subagent", arguments: { task: "Call the MCP tool and report." } };
      }
      return "Parent done.";
    },
  });
  // Install outside the workspace, as a user would, and let Pi discover its built-ins.
  const { client, reports, completed } = await rpcSession(t, dir);
  await client.prompt("Use the MCP tool, then delegate.");
  await Promise.race([childAsked.promise, completed]);
  assert.equal(calls.ping, 1, "only the parent has reached the server so far");
  release.resolve();
  await completed;

  assert.match(reports[0] ?? "", /: completed\n[\s\S]*Child reached MCP\./u);
  assert.equal(calls.ping, 2);
  // Exposure is unchanged: the tool is reached through codemode, not declared to the model.
  assert.ok(declared(childRequests[0]).includes("codemode"));
  assert.ok(!declared(childRequests[0]).includes(PING));
});

function launch(dir: string, tools: Pick<Launch, "activeTools" | "requiredTools">): Launch {
  return {
    cwd: dir,
    provider: "mock",
    model: "test-model",
    thinking: "off",
    trusted: false,
    extensions: ["builtin:mcp", "builtin:codemode"],
    mcpTools: [PING],
    task: "Call the MCP tool and report.",
    ...tools,
  };
}

test("children reach only the MCP tools named in their launch", {
  timeout: 30_000,
}, async (t) => {
  const { dir, release, childAsked, childRequests, calls } = await fixture(t, {
    holdListsFrom: 1,
    model: ({ toolResults }) =>
      toolResults === 0
        ? script(`text(await tools.${PING}({})); text(await tools.${OTHER}({}));`)
        : "Reported.",
  });
  const execution = startChild(
    launch(dir, { activeTools: ["codemode"], requiredTools: ["codemode"] }),
  );
  t.after(() => execution.cancel());
  await execution.ready;
  execution.run();
  await childAsked.promise;
  release.resolve();
  const result = await execution.done;
  assert.equal(result.status, "completed", result.report);
  assert.deepEqual(calls, { ping: 1, other: 0 });
  assert.equal(childRequests.length, 2);
});

test("direct MCP tools are declared in the child's first request", {
  timeout: 30_000,
}, async (t) => {
  const { dir, release, childRequests, calls } = await fixture(t, {
    exposure: "direct",
    holdListsFrom: 1,
    model: ({ toolResults }) => (toolResults === 0 ? { name: PING, arguments: {} } : "Reported."),
  });
  const execution = startChild(
    launch(dir, { activeTools: ["read", PING], requiredTools: ["read"] }),
  );
  t.after(() => execution.cancel());
  await execution.ready;
  assert.equal(childRequests.length, 0);
  execution.run();
  release.resolve();
  const result = await execution.done;
  assert.equal(result.status, "completed", result.report);
  assert.deepEqual(declared(childRequests[0]), ["read", PING]);
  assert.deepEqual(calls, { ping: 1, other: 0 });
});

test("children without MCP or reaching tools pass --no-mcp and never connect MCP servers", {
  timeout: 30_000,
}, async (t) => {
  // With `exposure: "direct"` and `holdListsFrom: 2` left unreleased, any child that loads
  // `builtin:mcp` would initialize the server and block startup waiting for `tools/list`.
  const { dir, childRequests, mcpRequests } = await fixture(t, {
    exposure: "direct",
    holdListsFrom: 2,
    model: ({ child, toolResults }) => {
      if (child) return "No MCP needed.";
      if (toolResults === 0) {
        return { name: "subagent", arguments: { task: "Inspect local files.", role: "explorer" } };
      }
      if (toolResults === 1) {
        return { name: "subagent", arguments: { task: "Pure reasoning.", role: "solver" } };
      }
      if (toolResults === 2) {
        return { name: "subagent", arguments: { task: "Modifier stripped MCP.", role: "no_mcp" } };
      }
      return "Parent done.";
    },
  });
  await writeFile(
    join(dir, "subagents.json"),
    JSON.stringify({
      roles: {
        solver: { tools: [] },
        no_mcp: { tools: [`-${PING}`, `-${OTHER}`] },
      },
    }),
  );
  const { client, reports, completed } = await rpcSession(t, dir, 3);
  await client.prompt("Delegate to explorer, solver, and no_mcp.");
  await completed;

  assert.equal(reports.length, 3);
  for (const report of reports) {
    assert.match(report, /: completed\n[\s\S]*No MCP needed\./u);
  }
  assert.equal(childRequests.length, 3);
  for (const request of childRequests) {
    assert.ok(!declared(request).includes(PING));
    assert.ok(!declared(request).includes(OTHER));
  }
  assert.deepEqual(mcpRequests, { initializes: 1, lists: 1 });
});

test("modifier, MCP-selecting, and codemode roles retain MCP access", {
  timeout: 60_000,
}, async (t) => {
  const { dir, calls, mcpRequests } = await fixture(t, {
    exposure: "codemode",
    toolExposure: { other: "direct" },
    holdListsFrom: 99,
    model: ({ child, toolResults, text }) => {
      if (child) {
        if (toolResults > 0) return "Role reached MCP.";
        return text.includes("USE_CODEMODE")
          ? script(`text(await tools.${PING}({}));`)
          : { name: OTHER, arguments: {} };
      }
      if (toolResults === 0) {
        return {
          name: "subagent",
          arguments: { task: "Use MCP via librarian.", role: "librarian" },
        };
      }
      if (toolResults === 1) {
        return {
          name: "subagent",
          arguments: { task: "Use MCP via explicit allowlist.", role: "mcp_reader" },
        };
      }
      if (toolResults === 2) {
        return {
          name: "subagent",
          arguments: { task: "USE_CODEMODE", role: "scripter" },
        };
      }
      return "Parent done.";
    },
  });
  await writeFile(
    join(dir, "subagents.json"),
    JSON.stringify({
      roles: {
        mcp_reader: { tools: ["read", OTHER] },
        scripter: { tools: ["read", "codemode"] },
      },
    }),
  );
  const { client, reports, completed } = await rpcSession(t, dir, 3);
  await client.prompt("Delegate to librarian, mcp_reader, and scripter.");
  await completed;

  assert.equal(reports.length, 3);
  for (const report of reports) {
    assert.match(report, /: completed\n[\s\S]*Role reached MCP\./u);
  }
  assert.deepEqual(calls, { ping: 1, other: 2 });
  assert.ok(mcpRequests.initializes >= 4);
});
