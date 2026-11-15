import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const cli = createRequire(import.meta.url).resolve("markdownlint-cli2");
const cliBin = fileURLToPath(new URL("./markdownlint-cli2-bin.mjs", pathToFileURL(cli)));

function lint(t: TestContext, markdown: string) {
  const directory = mkdtempSync(join(tmpdir(), "pi-markdownlint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "fixture.md"), markdown);
  writeFileSync(
    join(directory, ".markdownlint-cli2.yaml"),
    readFileSync(new URL("../.markdownlint-cli2.yaml", import.meta.url)),
  );
  const result = spawnSync(process.execPath, [cliBin], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

function renderMath(markdown: string, trust: "default" | "inherited" | "explicit" = "default") {
  // Resolve the actual CLI dependency chain, not an accidentally hoisted copy.
  // Isolate prototype mutation in a child process so it cannot affect other tests.
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: `
      import { createRequire } from "node:module";
      import { pathToFileURL } from "node:url";
      const fromCli = createRequire(${JSON.stringify(cli)});
      const fromLint = createRequire(fromCli.resolve("markdownlint"));
      const { micromark } = await import(pathToFileURL(fromLint.resolve("micromark")));
      const { math, mathHtml } = await import(pathToFileURL(fromLint.resolve("micromark-extension-math")));
      const mode = ${JSON.stringify(trust)};
      if (mode === "inherited") Object.defineProperty(Object.prototype, "trust", { value: true, writable: true, configurable: true });
      process.stdout.write(micromark(${JSON.stringify(markdown)}, {
        extensions: [math()],
        htmlExtensions: [mathHtml(mode === "explicit" ? { trust: true } : {})],
      }));
    `,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

test("Markdown lint accepts inline and block math with the repository configuration", (t) => {
  const result = lint(t, "# Math\n\nInline $x^2$.\n\n$$\n\\sum_{i=1}^{n}i\n$$\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Linting: 1 file\b/u);
});

test("Markdown lint still reports violations in documents containing math", (t) => {
  const result = lint(t, "Inline $x^2$ without a heading.\n");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /MD041/u);
});

test("the overridden math renderer handles inline and display formulas", () => {
  const result = renderMath("Inline $x^2$.\n\n$$\n\\sum_{i=1}^{n}i\n$$\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /class="math math-inline"/u);
  assert.match(result.stdout, /class="math math-display"/u);
  assert.match(result.stdout, /<math\b/u);
  assert.doesNotMatch(result.stdout, /katex-error/u);
});

test("the overridden math renderer rejects invalid TeX", () => {
  const result = renderMath("$\\notARealMathCommand$");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Undefined control sequence/u);
});

test("math rendering ignores inherited trust while honoring explicit opt-in", () => {
  const markdown = "$\\href{https://example.invalid}{x}$";
  for (const mode of ["default", "inherited"] as const) {
    const result = renderMath(markdown, mode);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /<a\s/u, `Unexpected trusted link in ${mode} mode`);
  }
  const trusted = renderMath(markdown, "explicit");
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.match(trusted.stdout, /<a href="https:\/\/example\.invalid"/u);
});
