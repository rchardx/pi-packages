import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface WorkspacePackage {
  directory: string;
  name: string;
  version: string;
  manifest: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nightlyVersion(base: string, run: string, sha: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(base)) {
    throw new Error(`Expected a stable package base version, got ${base}`);
  }
  if (!/^[1-9]\d*$/u.test(run)) throw new Error("Expected a positive GitHub run number");
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Expected a full lowercase commit SHA");
  return `${base}-nightly.${run}.g${sha}`;
}

export function assetName(name: string): string {
  if (!/^@rchardx\/pi-[a-z-]+$/u.test(name)) {
    throw new Error(`Unexpected workspace package name: ${name}`);
  }
  return `${name.slice("@rchardx/".length)}-nightly.tgz`;
}

export async function loadPackages(root: string): Promise<WorkspacePackage[]> {
  const entries = await readdir(join(root, "packages"), { withFileTypes: true });
  const packages: WorkspacePackage[] = [];
  for (const entry of entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(root, "packages", entry.name);
    const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (
      !record(manifest) ||
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string" ||
      manifest.private !== true
    ) {
      throw new Error(`Expected a named, versioned, private workspace: ${directory}`);
    }
    assetName(manifest.name);
    packages.push({ directory, name: manifest.name, version: manifest.version, manifest });
  }
  if (packages.length === 0) throw new Error("No workspace packages found");
  if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length) {
    throw new Error("Workspace package names must be unique");
  }
  return packages;
}

function packKind(manifest: Record<string, unknown>): "extension" | "skill" {
  const pi = manifest.pi;
  if (!record(pi)) throw new Error("Package manifest missing pi configuration");
  const hasExtensions = Array.isArray(pi.extensions) && pi.extensions.length > 0;
  const hasSkills = Array.isArray(pi.skills) && pi.skills.length > 0;
  if (hasExtensions === hasSkills) {
    throw new Error("Expected package manifest to declare either pi.extensions or pi.skills");
  }
  return hasSkills ? "skill" : "extension";
}

export function inspectPack(
  output: string,
  manifest: Record<string, unknown> = { pi: { extensions: ["./index.ts"] } },
): string {
  const kind = packKind(manifest);
  const results: unknown = JSON.parse(output);
  if (!Array.isArray(results) || results.length !== 1) throw new Error("Expected one npm tarball");
  const result: unknown = results[0];
  if (!record(result) || typeof result.filename !== "string" || !Array.isArray(result.files)) {
    throw new Error("Invalid npm pack result");
  }
  if (basename(result.filename) !== result.filename || !result.filename.endsWith(".tgz")) {
    throw new Error("Invalid npm tarball filename");
  }
  const paths: string[] = [];
  for (const file of result.files) {
    if (!record(file) || typeof file.path !== "string") throw new Error("Invalid npm pack file");
    paths.push(file.path);
  }
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required)) throw new Error(`Tarball missing ${required}`);
  }
  if (kind === "skill") {
    // Current skill packages ship root metadata and standalone SKILL.md files only.
    for (const path of paths) {
      if (
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !/^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/u.test(path)
      ) {
        throw new Error(`Unexpected tarball file: ${path}`);
      }
    }
    if (!paths.some((path) => path.startsWith("skills/")))
      throw new Error("Tarball missing skills");
  } else {
    if (!paths.includes("index.ts")) throw new Error("Tarball missing index.ts");
    // Extension packages ship root metadata, index.ts, and TypeScript runtime modules.
    for (const path of paths) {
      if (
        !["index.ts", "package.json", "README.md", "LICENSE"].includes(path) &&
        !/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.ts$/u.test(path)
      ) {
        throw new Error(`Unexpected tarball file: ${path}`);
      }
    }
    if (!paths.some((path) => path.startsWith("src/")))
      throw new Error("Tarball missing runtime modules");
  }
  console.log(`Inspected tarball files:\n${paths.join("\n")}`);
  return result.filename;
}

export async function packNightly(root: string, destination: string, run: string, sha: string) {
  const packages = await loadPackages(root);
  // Validate every version before producing any archive.
  for (const pkg of packages) nightlyVersion(pkg.version, run, sha);
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length !== 0) throw new Error("Archive directory must be empty");
  const staging = await mkdtemp(join(tmpdir(), "pi-nightly-pack-"));
  try {
    for (const pkg of packages) {
      const directory = join(staging, basename(pkg.directory));
      await cp(pkg.directory, directory, { recursive: true });
      const version = nightlyVersion(pkg.version, run, sha);
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({ ...pkg.manifest, version }, null, 2)}\n`,
      );
      const output = execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
        { cwd: directory, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const filename = inspectPack(output, pkg.manifest);
      await rename(join(destination, filename), join(destination, assetName(pkg.name)));
      console.log(`${pkg.name}@${version} -> ${assetName(pkg.name)}`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: nightly-pack.ts <empty-archives-directory>");
  await packNightly(
    process.cwd(),
    resolve(destination),
    process.env.GITHUB_RUN_NUMBER ?? "",
    process.env.NIGHTLY_SHA ?? "",
  );
}
