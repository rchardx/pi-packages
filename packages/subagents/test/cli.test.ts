import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parentOptions } from "../src/cli.ts";

for (const source of [
  "./extension.ts",
  "extensions/local.ts",
  "/tmp/extension.ts",
  "~/extensions/local.ts",
  "builtin:codemode",
  "npm:@example/pi-tools@1.2.3",
  "git:github.com/example/pi-tools@main",
  "https://github.com/example/pi-tools",
  "ssh://git@github.com/example/pi-tools",
  "git@github.com:example/pi-tools.git",
  "github.com/example/pi-tools",
]) {
  test(`forwards extension source unchanged: ${source}`, () => {
    assert.deepEqual(parentOptions(["-e", source], process.cwd()).extensions, [source]);
  });
}

for (const flag of ["-ne", "--no-extensions"]) {
  test(`retains ${flag}, explicit sources, MCP and network restrictions`, () => {
    const options = parentOptions(
      [
        flag,
        "--no-mcp",
        "--offline",
        "-e",
        "builtin:codemode",
        "--extension",
        "npm:@example/pi-tools",
      ],
      process.cwd(),
    );
    assert.equal(options.noExtensions, true);
    assert.equal(options.noMcp, true);
    assert.deepEqual(options.flags, ["--no-extensions", "--no-mcp", "--offline"]);
    assert.deepEqual(options.extensions, ["builtin:codemode", "npm:@example/pi-tools"]);
  });
}

test("uses Pi parsing so option values and positional prompts cannot become forwarded flags", () => {
  const options = parentOptions(
    [
      "--system-prompt",
      "-ne",
      "--append-system-prompt",
      "--no-mcp",
      "--",
      "-e",
      "npm:unwanted",
      "--offline",
      "--api-key",
      "not-a-key",
    ],
    process.cwd(),
  );
  assert.equal(options.noExtensions, false);
  assert.equal(options.noMcp, false);
  assert.deepEqual(options.extensions, []);
  assert.deepEqual(options.flags, ["--system-prompt", "-ne", "--append-system-prompt", "--no-mcp"]);
  assert.throws(
    () => parentOptions(["--api-key", "test-override"], process.cwd()),
    /API-key override/u,
  );
});

test("retains context/skill and tool exclusions without forwarding unrelated CLI flags", () => {
  assert.deepEqual(
    parentOptions(
      ["-ns", "-nc", "-xt", "mcp__*,write", "--model", "something", "--custom-flag", "ignored"],
      process.cwd(),
    ).flags,
    ["--no-skills", "--no-context-files", "--exclude-tools", "mcp__*,write"],
  );
});

test("strips --agent-dir values before parseArgs, matching Pi main() pre-parsing", () => {
  const dashPrefixed = parentOptions(
    ["--agent-dir", "-ne", "--agent-dir", "@profile", "-e", "./ext.ts", "--", "--agent-dir", "-ne"],
    process.cwd(),
  );
  assert.equal(dashPrefixed.noExtensions, false);
  assert.deepEqual(dashPrefixed.extensions, ["./ext.ts"]);
  assert.deepEqual(dashPrefixed.flags, []);
});

test("forwards explicit prompt inputs once, keeping append order and fixing existing file paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "system.md"), "Custom base");
  await writeFile(join(dir, "append.md"), "Additional instruction");
  const options = parentOptions(
    [
      "--system-prompt",
      "system.md",
      "--append-system-prompt",
      "Literal instruction",
      "--append-system-prompt",
      "append.md",
    ],
    dir,
  );
  assert.deepEqual(options.flags, [
    "--system-prompt",
    join(dir, "system.md"),
    "--append-system-prompt",
    "Literal instruction",
    "--append-system-prompt",
    join(dir, "append.md"),
  ]);
  assert.deepEqual(parentOptions([], dir).flags, []);
  assert.deepEqual(
    parentOptions(["--system-prompt", "", "--append-system-prompt", ""], dir).flags,
    ["--system-prompt", "", "--append-system-prompt", ""],
  );
});
