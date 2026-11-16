import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEADLINE_MS, MAX_CONCURRENT, MAX_REQUESTS } from "./protocol.ts";

export const DEFAULT_MAX_CONCURRENT = MAX_CONCURRENT;
export const DEFAULT_MAX_REQUESTS = MAX_REQUESTS;
export const DEFAULT_DEADLINE_SECONDS = DEADLINE_MS / 1000;
/** setTimeout's maximum delay in seconds; larger deadlines cannot be represented. */
export const MAX_DEADLINE_SECONDS = 2_147_483;

const ALLOWED_KEYS = new Set(["maxConcurrent", "maxRequests", "deadlineSeconds"]);

export interface SubagentsConfig {
  /** Maximum number of subagents running concurrently in a root session. */
  maxConcurrent: number;
  /** Maximum admitted model turns per child execution. */
  maxRequests: number;
  /** Total execution deadline per child in seconds, including startup. */
  deadlineSeconds: number;
}

export function parseConfig(value: unknown): SubagentsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new Error(
      "Unknown configuration field; only maxConcurrent, maxRequests, and deadlineSeconds are supported.",
    );
  }
  const maxConcurrent = "maxConcurrent" in value ? value.maxConcurrent : DEFAULT_MAX_CONCURRENT;
  if (typeof maxConcurrent !== "number" || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer.");
  }
  const maxRequests = "maxRequests" in value ? value.maxRequests : DEFAULT_MAX_REQUESTS;
  if (typeof maxRequests !== "number" || !Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new Error("maxRequests must be a positive integer.");
  }
  const deadlineSeconds =
    "deadlineSeconds" in value ? value.deadlineSeconds : DEFAULT_DEADLINE_SECONDS;
  if (
    typeof deadlineSeconds !== "number" ||
    !Number.isFinite(deadlineSeconds) ||
    deadlineSeconds <= 0 ||
    deadlineSeconds > MAX_DEADLINE_SECONDS
  ) {
    throw new Error(
      `deadlineSeconds must be a positive number of seconds at most ${MAX_DEADLINE_SECONDS}.`,
    );
  }
  return { maxConcurrent, maxRequests, deadlineSeconds };
}

// User configuration only, re-read per launch so edits apply without a reload.
export async function loadConfig(
  path = join(getAgentDir(), "subagents.json"),
): Promise<SubagentsConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
        maxRequests: DEFAULT_MAX_REQUESTS,
        deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
      };
    }
    throw new Error(`Cannot read subagents configuration: ${path}`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(source);
    return parseConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid subagents configuration (${path}): ${message}`, { cause: error });
  }
}
