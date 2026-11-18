import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

export interface CommandCandidate {
  command: string;
  args: readonly string[];
  /** Resolve only from ancestor `node_modules/.bin`, accepting a match only when this returns true. */
  localOnly?: (binPath: string) => Promise<boolean>;
}

export interface ServerDefinition {
  id: string;
  candidates: readonly CommandCandidate[];
  extensions: readonly string[];
  rootMarkers: readonly string[];
  languageIdForPath(filePath: string): string;
  initializationOptions?: Record<string, unknown>;
}

const DEFAULT_REQUEST_TIMEOUT_SECONDS = 15;

const TS_LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

/** True when `binPath` is `node_modules/.bin/tsc` from a TypeScript 7+ package with native LSP support. */
async function isNativeTypeScriptTsc(binPath: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(dirname(dirname(binPath)), "typescript", "package.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
      return false;
    }
    const major = Number.parseInt(String(manifest.version), 10);
    return major >= 7;
  } catch {
    return false;
  }
}

export const BUILTIN_SERVERS: readonly ServerDefinition[] = [
  {
    id: "typescript",
    candidates: [
      { command: "tsc", args: ["--lsp", "--stdio"], localOnly: isNativeTypeScriptTsc },
      { command: "typescript-language-server", args: ["--stdio"] },
    ],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    languageIdForPath(filePath) {
      return TS_LANGUAGE_BY_EXT[extname(filePath).toLowerCase()] ?? "typescript";
    },
  },
  {
    id: "python",
    candidates: [
      { command: "basedpyright-langserver", args: ["--stdio"] },
      { command: "pyright-langserver", args: ["--stdio"] },
      { command: "pylsp", args: [] },
    ],
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", ".git"],
    languageIdForPath() {
      return "python";
    },
  },
  {
    id: "rust",
    candidates: [{ command: "rust-analyzer", args: [] }],
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
    languageIdForPath() {
      return "rust";
    },
  },
  {
    id: "go",
    candidates: [{ command: "gopls", args: [] }],
    extensions: [".go"],
    rootMarkers: ["go.work", "go.mod"],
    languageIdForPath() {
      return "go";
    },
  },
  {
    id: "clangd",
    candidates: [{ command: "clangd", args: [] }],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
    rootMarkers: ["compile_commands.json", ".clangd", "CMakeLists.txt", ".git"],
    languageIdForPath(filePath) {
      const ext = extname(filePath).toLowerCase();
      return ext === ".c" || ext === ".h" ? "c" : "cpp";
    },
  },
];

const CustomServerSchema = Type.Object(
  {
    command: Type.String({ pattern: "\\S" }),
    args: Type.Optional(Type.Array(Type.String())),
    extensions: Type.Array(Type.String({ pattern: "^\\.[A-Za-z0-9_+-]+$" }), { minItems: 1 }),
    rootMarkers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    languageId: Type.String({ pattern: "^\\S+$" }),
    initializationOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const ConfigFileSchema = Type.Object(
  {
    diagnosticsOnEdit: Type.Optional(Type.Boolean()),
    requestTimeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
    servers: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^\\S+$" }),
        Type.Union([Type.Literal(false), CustomServerSchema]),
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type RawConfigFile = Static<typeof ConfigFileSchema>;

export interface LspConfig {
  diagnosticsOnEdit: boolean;
  requestTimeoutMs: number;
  servers: readonly ServerDefinition[];
}

export function configFilePath(): string {
  return join(getAgentDir(), "lsp.json");
}

export function parseConfig(raw: unknown): LspConfig {
  if (!Check(ConfigFileSchema, raw)) {
    // The deepest error is the most specific one (e.g. a field inside a `false | server` union).
    const errors = [...Errors(ConfigFileSchema, raw)];
    const first = errors.reduce<(typeof errors)[number] | undefined>(
      (best, error) =>
        !best || error.instancePath.length > best.instancePath.length ? error : best,
      undefined,
    );
    const where = first?.instancePath || "(root)";
    // TypeBox reports unknown keys as `additionalProperties: false` ("schema is false").
    const problem = first?.keyword === "boolean" ? "unknown property" : first?.message;
    throw new Error(`Invalid LSP configuration in ${configFilePath()}: ${where}: ${problem}.`);
  }
  const parsed: RawConfigFile = raw;
  const builtinMap = new Map<string, ServerDefinition>();
  for (const builtin of BUILTIN_SERVERS) {
    builtinMap.set(builtin.id, builtin);
  }
  const customServers: ServerDefinition[] = [];

  if (parsed.servers) {
    for (const [id, entry] of Object.entries(parsed.servers)) {
      builtinMap.delete(id);
      if (entry === false) {
        continue;
      }
      const extensions = entry.extensions.map((ext) => ext.toLowerCase());
      const languageId = entry.languageId;
      customServers.push({
        id,
        candidates: [{ command: entry.command, args: entry.args ?? [] }],
        extensions,
        rootMarkers: entry.rootMarkers ?? [".git"],
        languageIdForPath() {
          return languageId;
        },
        ...(entry.initializationOptions
          ? { initializationOptions: entry.initializationOptions }
          : {}),
      });
    }
  }

  return {
    diagnosticsOnEdit: parsed.diagnosticsOnEdit ?? true,
    requestTimeoutMs: Math.round(
      (parsed.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000,
    ),
    servers: [...customServers, ...builtinMap.values()],
  };
}

export async function loadConfig(path = configFilePath()): Promise<LspConfig> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return parseConfig({});
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseConfig(json);
}

export function matchServerForFile(
  config: LspConfig,
  filePath: string,
): ServerDefinition | undefined {
  const ext = extname(filePath).toLowerCase();
  if (!ext) return undefined;
  return config.servers.find((server) => server.extensions.includes(ext));
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasMarker(dir: string, rootMarkers: readonly string[]): Promise<boolean> {
  for (const marker of rootMarkers) {
    if (await exists(join(dir, marker))) return true;
  }
  return false;
}

/**
 * Pick the workspace root for `filePath`, which must be inside `sessionCwd` (both given as
 * canonical paths, so the walk up cannot pass the session directory): the outermost
 * directory up to and including `sessionCwd` that contains a root marker (so monorepo packages
 * share one server), falling back to `sessionCwd`.
 */
export async function findWorkspaceRoot(
  filePath: string,
  rootMarkers: readonly string[],
  sessionCwd: string,
): Promise<string> {
  const cwd = resolve(sessionCwd);
  let outermost: string | undefined;
  let current = resolve(dirname(filePath));
  for (;;) {
    if (await hasMarker(current, rootMarkers)) outermost = current;
    const parent = dirname(current);
    if (current === cwd || parent === current) break;
    current = parent;
  }
  return outermost ?? cwd;
}

export interface ResolvedBinary {
  command: string;
  args: readonly string[];
}

/**
 * Resolve the first installed executable among a server's `candidates`,
 * checking ancestor `node_modules/.bin` directories first and then `PATH`.
 */
export async function resolveServerBinary(
  server: ServerDefinition,
  workspaceRoot: string,
  envPath = process.env.PATH ?? "",
): Promise<ResolvedBinary | undefined> {
  for (const candidate of server.candidates) {
    const { command, args, localOnly } = candidate;
    if (isAbsolute(command)) {
      if (await isExecutable(command)) {
        return { command, args };
      }
      continue;
    }

    let current = resolve(workspaceRoot);
    for (;;) {
      const localBin = join(current, "node_modules", ".bin", command);
      if ((await isExecutable(localBin)) && (!localOnly || (await localOnly(localBin)))) {
        return { command: localBin, args };
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    if (localOnly) continue;
    for (const dir of envPath.split(delimiter)) {
      if (!dir) continue;
      const fullPath = join(dir, command);
      if (await isExecutable(fullPath)) {
        return { command: fullPath, args };
      }
    }
  }

  return undefined;
}
