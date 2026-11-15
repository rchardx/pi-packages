import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_MAX_JOBS,
  DEFAULT_THRESHOLD_SECONDS,
  loadConfig,
  MAX_THRESHOLD_SECONDS,
  parseConfig,
} from "../src/config.ts";

test("parseConfig applies defaults and accepts overrides", () => {
  assert.deepEqual(parseConfig({}), {
    thresholdSeconds: DEFAULT_THRESHOLD_SECONDS,
    maxJobs: DEFAULT_MAX_JOBS,
  });
  assert.deepEqual(parseConfig({ thresholdSeconds: 30, maxJobs: 4 }), {
    thresholdSeconds: 30,
    maxJobs: 4,
  });
  // Fractional thresholds are valid (sub-second thresholds are used in tests).
  assert.equal(parseConfig({ thresholdSeconds: 0.2 }).thresholdSeconds, 0.2);
  // 0 disables auto-backgrounding; the maximum is setTimeout's delay limit.
  assert.equal(parseConfig({ thresholdSeconds: 0 }).thresholdSeconds, 0);
  assert.equal(
    parseConfig({ thresholdSeconds: MAX_THRESHOLD_SECONDS }).thresholdSeconds,
    MAX_THRESHOLD_SECONDS,
  );
});

test("parseConfig rejects invalid input", () => {
  assert.throws(() => parseConfig(null), /JSON object/u);
  assert.throws(() => parseConfig([]), /JSON object/u);
  assert.throws(() => parseConfig({ threshold: 1 }), /Unknown configuration field/u);
  assert.throws(() => parseConfig({ thresholdSeconds: -1 }), /between 0/u);
  assert.throws(() => parseConfig({ thresholdSeconds: Number.NaN }), /between 0/u);
  assert.throws(() => parseConfig({ thresholdSeconds: MAX_THRESHOLD_SECONDS + 1 }), /between 0/u);
  assert.throws(() => parseConfig({ maxJobs: 0 }), /positive integer/u);
  assert.throws(() => parseConfig({ maxJobs: 2.5 }), /positive integer/u);
});

test("loadConfig returns defaults when the file is missing and parses when present", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-background-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "background.json");

  assert.deepEqual(await loadConfig(path), {
    thresholdSeconds: DEFAULT_THRESHOLD_SECONDS,
    maxJobs: DEFAULT_MAX_JOBS,
  });

  await writeFile(path, JSON.stringify({ thresholdSeconds: 5, maxJobs: 2 }));
  assert.deepEqual(await loadConfig(path), { thresholdSeconds: 5, maxJobs: 2 });

  await writeFile(path, "{not json");
  await assert.rejects(loadConfig(path), /Invalid background configuration/u);

  await writeFile(path, JSON.stringify({ unknown: true }));
  await assert.rejects(loadConfig(path), /Unknown configuration field/u);
});
