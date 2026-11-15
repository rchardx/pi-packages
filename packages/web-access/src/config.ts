import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface Config {
  search?: { provider: "deepseek" };
  fetch?: { provider: "deepseek" };
}

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  const config: Config = {};
  const entries: [string, unknown][] = Object.entries(value);
  for (const [key, setting] of entries) {
    if (key !== "search" && key !== "fetch") {
      throw new Error("Unknown configuration field; only search and fetch are supported.");
    }
    if (
      !setting ||
      typeof setting !== "object" ||
      Array.isArray(setting) ||
      Object.keys(setting).some((field) => field !== "provider") ||
      !("provider" in setting) ||
      setting.provider !== "deepseek"
    ) {
      throw new Error(`${key} must be { "provider": "deepseek" }; omit it to disable ${key}.`);
    }
    config[key] = { provider: "deepseek" };
  }
  return config;
}

// User configuration only, re-read per invocation. Never let project settings
// or tool arguments authorize credential use or hosted URL/query disclosure.
export async function loadConfig(path = join(getAgentDir(), "web-access.json")): Promise<Config> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Cannot read web access configuration: ${path}`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(source);
    return parseConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid web access configuration (${path}): ${message}`, { cause: error });
  }
}
