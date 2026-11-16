import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_REQUESTS,
  loadConfig,
  MAX_DEADLINE_SECONDS,
  parseConfig,
} from "../src/config.ts";

test("parseConfig applies defaults and accepts overrides", () => {
  assert.deepEqual(parseConfig({}), {
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    maxRequests: DEFAULT_MAX_REQUESTS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
  });
  assert.equal(DEFAULT_MAX_CONCURRENT, 8);
  assert.deepEqual(parseConfig({ maxConcurrent: 4, maxRequests: 16, deadlineSeconds: 300 }), {
    maxConcurrent: 4,
    maxRequests: 16,
    deadlineSeconds: 300,
  });
  assert.equal(parseConfig({ deadlineSeconds: 0.5 }).deadlineSeconds, 0.5);
  assert.equal(
    parseConfig({ deadlineSeconds: MAX_DEADLINE_SECONDS }).deadlineSeconds,
    MAX_DEADLINE_SECONDS,
  );
});

test("parseConfig rejects invalid input", () => {
  assert.throws(() => parseConfig(null), /JSON object/u);
  assert.throws(() => parseConfig([]), /JSON object/u);
  assert.throws(() => parseConfig({ maxJobs: 4 }), /Unknown configuration field/u);
  assert.throws(() => parseConfig({ maxConcurrent: 0 }), /positive integer/u);
  assert.throws(() => parseConfig({ maxConcurrent: 2.5 }), /positive integer/u);
  assert.throws(() => parseConfig({ maxRequests: 0 }), /positive integer/u);
  assert.throws(() => parseConfig({ maxRequests: -3 }), /positive integer/u);
  assert.throws(() => parseConfig({ deadlineSeconds: 0 }), /positive number/u);
  assert.throws(() => parseConfig({ deadlineSeconds: -1 }), /positive number/u);
  assert.throws(() => parseConfig({ deadlineSeconds: Number.NaN }), /positive number/u);
  assert.throws(
    () => parseConfig({ deadlineSeconds: MAX_DEADLINE_SECONDS + 1 }),
    /positive number/u,
  );
});

test("loadConfig returns defaults when missing and fails closed when invalid", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "subagents.json");

  assert.deepEqual(await loadConfig(path), {
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    maxRequests: DEFAULT_MAX_REQUESTS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
  });

  await writeFile(path, JSON.stringify({ maxConcurrent: 2, maxRequests: 10 }));
  assert.deepEqual(await loadConfig(path), {
    maxConcurrent: 2,
    maxRequests: 10,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
  });

  await writeFile(path, "{invalid");
  await assert.rejects(loadConfig(path), /Invalid subagents configuration/u);

  await writeFile(path, JSON.stringify({ extra: true }));
  await assert.rejects(loadConfig(path), /Unknown configuration field/u);
});
