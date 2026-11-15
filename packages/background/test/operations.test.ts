import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTeeOperations } from "../src/operations.ts";

function nodeScript(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

test("the tee receives every chunk while the wrapped consumer is forwarded to", async () => {
  const teed: Buffer[] = [];
  const forwarded: Buffer[] = [];
  const tapping = createTeeOperations((data) => teed.push(data));
  const result = await tapping.operations.exec(
    nodeScript('process.stdout.write("out"); process.stderr.write("err")'),
    process.cwd(),
    { onData: (data) => forwarded.push(data) },
  );
  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.concat(teed).toString("utf8").includes("out"));
  assert.ok(Buffer.concat(forwarded).toString("utf8").includes("err"));
});

test("stopForwarding keeps the tee live but stops the wrapped consumer", async () => {
  const teed: Buffer[] = [];
  const forwarded: Buffer[] = [];
  const tapping = createTeeOperations((data) => teed.push(data));
  const exec = tapping.operations.exec(
    nodeScript(
      'process.stdout.write("first\\n"); setTimeout(() => process.stdout.write("second\\n"), 300)',
    ),
    process.cwd(),
    { onData: (data) => forwarded.push(data) },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  tapping.stopForwarding();
  const result = await exec;
  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.concat(teed).toString("utf8").includes("second"));
  assert.ok(!Buffer.concat(forwarded).toString("utf8").includes("second"));
});

test("aborting the passed signal kills the process tree via pi's own backend", async () => {
  const tapping = createTeeOperations(() => {});
  const controller = new AbortController();
  const exec = tapping.operations.exec(nodeScript("setTimeout(() => {}, 30000)"), process.cwd(), {
    onData: () => {},
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(exec, /aborted/u);
});

test("a custom shellPath is honored", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-background-shell-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeShell = join(directory, "fake-shell.sh");
  await writeFile(fakeShell, "#!/bin/sh\necho fake-shell-invoked\n");
  await chmod(fakeShell, 0o755);
  const tapping = createTeeOperations(() => {}, { shellPath: fakeShell });
  const chunks: Buffer[] = [];
  await tapping.operations.exec("anything", process.cwd(), {
    onData: (data) => chunks.push(data),
  });
  assert.ok(Buffer.concat(chunks).toString("utf8").includes("fake-shell-invoked"));
});

test("timeout validation and the timeout:<seconds> form come from the built-in backend", async () => {
  const tapping = createTeeOperations(() => {});
  await assert.rejects(
    tapping.operations.exec("true", process.cwd(), { onData: () => {}, timeout: -1 }),
    /Invalid timeout/u,
  );
  await assert.rejects(
    tapping.operations.exec(nodeScript("setTimeout(() => {}, 30000)"), process.cwd(), {
      onData: () => {},
      timeout: 0.2,
    }),
    /^Error: timeout:0\.2$/u,
  );
});
