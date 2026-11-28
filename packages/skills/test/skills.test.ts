import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionServices,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const skillsRoot = join(packageRoot, "skills");
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

async function listSkillDirs(): Promise<string[]> {
  if (!existsSync(skillsRoot)) return [];
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  assert.ok(match?.[1], "SKILL.md must begin with a YAML frontmatter block");
  const fields: Record<string, string> = {};
  for (const rawLine of match[1].split("\n")) {
    const idx = rawLine.indexOf(":");
    assert.ok(idx > 0, `Invalid frontmatter line: ${rawLine}`);
    const key = rawLine.slice(0, idx).trim();
    const value = rawLine
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/gu, "");
    fields[key] = value;
  }
  return fields;
}

test("package.json stays private and free of runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    private?: boolean;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});

test("every skill directory follows Agent Skills naming and frontmatter contracts", async () => {
  const dirs = await listSkillDirs();
  assert.ok(dirs.length > 0, "packages/skills must contain at least one skill");
  for (const dir of dirs) {
    assert.ok(dir.length <= 64 && SKILL_NAME.test(dir), `Invalid skill directory name: ${dir}`);
    const skillPath = join(skillsRoot, dir, "SKILL.md");
    assert.ok(existsSync(skillPath), `Missing SKILL.md in skills/${dir}`);
    const content = await readFile(skillPath, "utf8");
    const frontmatter = parseFrontmatter(content);
    assert.equal(frontmatter.name, dir, `skills/${dir}/SKILL.md name must match directory`);
    assert.ok(
      frontmatter.description && frontmatter.description.length <= 1024,
      `skills/${dir}/SKILL.md must declare a non-empty description <= 1024 chars`,
    );
  }
});

test("Pi discovers package skills cleanly without diagnostics", async (t: TestContext) => {
  const homeDir = await mkdtemp(join(tmpdir(), "pi-skills-home-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-skills-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-skills-cwd-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOffline = process.env.PI_OFFLINE;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "catalog.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: true,
      noThemes: true,
      noContextFiles: true,
    },
  });

  const expectedDirs = await listSkillDirs();
  const loadedSkills = services.resourceLoader.getSkills();

  assert.deepEqual(loadedSkills.diagnostics, []);
  assert.deepEqual(loadedSkills.skills.map((skill) => skill.name).sort(), expectedDirs);
  const reviewLoop = loadedSkills.skills.find((skill) => skill.name === "review-loop");
  assert.ok(reviewLoop);
  assert.equal(reviewLoop.disableModelInvocation, true);

  const deepResearch = loadedSkills.skills.find((skill) => skill.name === "deep-research");
  assert.ok(deepResearch);
  assert.equal(deepResearch.disableModelInvocation, false);
});
