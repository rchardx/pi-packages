import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_THRESHOLD_SECONDS = 120;
export const DEFAULT_MAX_JOBS = 16;
/** setTimeout's maximum delay in seconds; larger thresholds cannot be represented. */
export const MAX_THRESHOLD_SECONDS = 2_147_483;

export interface BackgroundConfig {
  /** Seconds a foreground command may run before it moves to the background; 0 disables auto-backgrounding. */
  thresholdSeconds: number;
  /** Maximum number of concurrently running background jobs. */
  maxJobs: number;
}

export function parseConfig(value: unknown): BackgroundConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  if (Object.keys(value).some((key) => key !== "thresholdSeconds" && key !== "maxJobs")) {
    throw new Error(
      "Unknown configuration field; only thresholdSeconds and maxJobs are supported.",
    );
  }
  const thresholdSeconds =
    "thresholdSeconds" in value ? value.thresholdSeconds : DEFAULT_THRESHOLD_SECONDS;
  if (
    typeof thresholdSeconds !== "number" ||
    !Number.isFinite(thresholdSeconds) ||
    thresholdSeconds < 0 ||
    thresholdSeconds > MAX_THRESHOLD_SECONDS
  ) {
    throw new Error(
      `thresholdSeconds must be a number of seconds between 0 (auto-backgrounding disabled) and ${MAX_THRESHOLD_SECONDS}.`,
    );
  }
  const maxJobs = "maxJobs" in value ? value.maxJobs : DEFAULT_MAX_JOBS;
  if (typeof maxJobs !== "number" || !Number.isInteger(maxJobs) || maxJobs < 1) {
    throw new Error("maxJobs must be a positive integer.");
  }
  return { thresholdSeconds, maxJobs };
}

// User configuration only, re-read per invocation so edits apply without a reload.
export async function loadConfig(
  path = join(getAgentDir(), "background.json"),
): Promise<BackgroundConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { thresholdSeconds: DEFAULT_THRESHOLD_SECONDS, maxJobs: DEFAULT_MAX_JOBS };
    }
    throw new Error(`Cannot read background configuration: ${path}`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(source);
    return parseConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid background configuration (${path}): ${message}`, { cause: error });
  }
}
