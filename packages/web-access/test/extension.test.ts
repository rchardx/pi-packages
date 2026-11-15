import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fixture } from "./_server.ts";

test("Pi discovers the package manifest, loads the extension, and executes web_fetch without auth", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-extension-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "catalog.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
    tools: ["web_fetch"],
  });
  t.after(() => session.dispose());
  assert.deepEqual(session.getActiveToolNames(), ["web_fetch"]);
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(tool);

  const { server } = await fixture(t, (_request, response) => {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<h1>SDK fixture</h1><p>Readable without an API key.</p>");
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  // Keep the Pi-loaded implementation real; replace only outbound TLS transport.
  t.mock.method(
    https,
    "get",
    (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const target = new URL(url);
      target.protocol = "http:";
      target.port = String(address.port);
      return http.get(
        target,
        { ...options, lookup: (_host, _options, done) => done(null, "127.0.0.1", 4) },
        callback,
      );
    },
  );
  const result = await tool.execute("sdk-success", { url: "https://example.test/guide" });
  const content = result.content[0];
  assert.equal(content?.type, "text");
  assert.ok(content && content.type === "text");
  assert.match(content.text, /SDK FIXTURE/u);
  assert.match(content.text, /Readable without an API key/u);
  await assert.rejects(tool.execute("sdk-blocked", { url: "http://127.0.0.1" }), /non-public/u);

  // Configuration is user-owned and reloaded per invocation, not cached at startup.
  const localUrl = `http://127.0.0.1:${address.port}/guide`;
  await writeFile(
    join(directory, "web-access.json"),
    JSON.stringify({ allowRanges: ["127.0.0.1/32"] }),
  );
  const allowed = await tool.execute("sdk-configured", { url: localUrl });
  assert.equal(allowed.content[0]?.type, "text");
  await writeFile(join(directory, "web-access.json"), "{}");
  await assert.rejects(tool.execute("sdk-revoked", { url: localUrl }), /non-public/u);
  await writeFile(
    join(directory, "web-access.json"),
    JSON.stringify({ allowRanges: ["0.0.0.0/0"] }),
  );
  await assert.rejects(
    tool.execute("sdk-invalid-config", { url: "https://example.test" }),
    /Invalid web access configuration/u,
  );
});
