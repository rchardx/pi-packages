import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import ipaddr from "ipaddr.js";

export type AllowRange = ReturnType<typeof ipaddr.parseCIDR>;

interface Config {
  allowRanges: AllowRange[];
  search?: { provider: "deepseek" };
}

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  if (Object.keys(value).some((key) => key !== "allowRanges" && key !== "search")) {
    throw new Error("Unknown configuration field; only allowRanges and search are supported.");
  }
  if ("search" in value) {
    const search = value.search;
    if (
      !search ||
      typeof search !== "object" ||
      Array.isArray(search) ||
      Object.keys(search).some((key) => key !== "provider") ||
      !("provider" in search) ||
      search.provider !== "deepseek"
    ) {
      throw new Error('search must be { "provider": "deepseek" }; omit it to disable search.');
    }
  }
  const entries = "allowRanges" in value ? value.allowRanges : [];
  if (!Array.isArray(entries)) throw new Error("allowRanges must be an array of CIDR strings.");
  const allowRanges = entries.map((entry: unknown): AllowRange => {
    if (typeof entry !== "string") throw new Error("allowRanges must contain CIDR strings.");
    const parts = entry.split("/");
    const [address, prefix] = parts;
    if (
      parts.length !== 2 ||
      !address ||
      !isIP(address) ||
      address.includes("%") ||
      !prefix ||
      !/^(0|[1-9]\d*)$/u.test(prefix) ||
      !ipaddr.isValidCIDR(entry)
    ) {
      throw new Error(`Invalid CIDR in allowRanges: ${entry}`);
    }
    const range = ipaddr.parseCIDR(entry);
    if (range[1] === 0) throw new Error("allowRanges must not include an all-address /0 range.");
    if (range[0] instanceof ipaddr.IPv6 && range[0].isIPv4MappedAddress()) {
      throw new Error("Use an IPv4 CIDR instead of an IPv4-mapped IPv6 CIDR in allowRanges.");
    }
    return range;
  });
  return {
    allowRanges,
    ...("search" in value ? { search: { provider: "deepseek" as const } } : {}),
  };
}

// User configuration only, re-read per invocation. Never load project settings
// or let tool arguments change network permissions.
export async function loadConfig(path = join(getAgentDir(), "web-access.json")): Promise<Config> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { allowRanges: [] };
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
