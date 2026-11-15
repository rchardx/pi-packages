import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import ipaddr from "ipaddr.js";

export type AllowRange = ReturnType<typeof ipaddr.parseCIDR>;

export function parseConfig(value: unknown): { allowRanges: AllowRange[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  if (Object.keys(value).some((key) => key !== "allowRanges")) {
    throw new Error("Unknown configuration field; only allowRanges is supported.");
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
  return { allowRanges };
}

// User configuration only, re-read per invocation. Never load project settings
// or let tool arguments change network permissions.
export async function loadConfig(path = join(getAgentDir(), "web-access.json")) {
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
