import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateCommitMessage } from "./check-commit-message.ts";

const subject = "docs(commit): clarify blank line rules";
const summary = "Document the expected spacing for commit messages.";
const valid = `${subject}

${summary}

Key changes:
- Explain the preferred body layout
- Keep bullets adjacent
`;
const withSubject = (value: string) => valid.replace(subject, value);

const accepted = {
  control: valid,
  "71-character subject": withSubject(`fix(store.v2_a-b): ${"a".repeat(52)}`),
  "asterisk bullets": valid.replaceAll("- ", "* "),
  "comments and scissors": `# note\n${valid}# comment\n# ------------------------ >8 ------------------------\n更新\n`,
  "footer and trailing blanks": `${valid}\nRefs: #12\n\n\n`,
  "English technical typography": valid.replace(summary, "Use a·b × 100 for t−1."),
  "breaking marker": `${withSubject("feat(config)!: rename settings")}\nRebuild:\nGenerate fresh configuration.\n`,
  "breaking footer": `${valid}\nBREAKING CHANGE: settings changed.\n\nRebuild:\nGenerate fresh configuration.\n`,
  "wrapped summary": valid.replace(summary, "Document the expected\nspacing for commit messages."),
  "wrapped bullet": valid.replace("body layout", "body\nlayout"),
  "wrapped bullet before validation section": `${valid.replace("body layout", "body\n  layout")}\nValidation:\n- npm test\n`,
  "CRLF input": valid.replaceAll("\n", "\r\n"),
};

for (const [name, message] of Object.entries(accepted)) {
  test(`accepts ${name}`, () => {
    assert.deepEqual(validateCommitMessage(message), []);
  });
}

const rejected: [string, string, string][] = [
  ["empty input", "# comment\n", "commit message is empty"],
  ["unknown type", withSubject("build: change tooling"), "allowed types:"],
  ["uppercase scope", withSubject("docs(Commit): clarify rules"), "subject must follow"],
  ["missing description", withSubject("docs: "), "subject must follow"],
  ["72-character subject", withSubject(`fix(store.v2_a-b): ${"a".repeat(53)}`), "under 72"],
  ["missing body", subject, "'Key changes:' section"],
  ["breaking marker without body", "feat!: replace config", "must include a body"],
  [
    "missing separator",
    valid.replace(`${subject}\n\n`, `${subject}\n`),
    "between subject and body",
  ],
  ["extra separator", valid.replace(`${subject}\n\n`, `${subject}\n\n\n`), "single paragraph"],
  ["missing summary", valid.replace(`${summary}\n\n`, ""), "summary paragraph"],
  [
    "missing summary separator",
    valid.replace(`${summary}\n\n`, `${summary}\n`),
    "between body summary",
  ],
  [
    "extra summary separator",
    valid.replace(`${summary}\n\n`, `${summary}\n\n\n`),
    "between body summary",
  ],
  ["multiple paragraphs", valid.replace(summary, "First.\n\nSecond."), "single paragraph"],
  ["blank before bullets", valid.replace("Key changes:\n", "Key changes:\n\n"), "blank line after"],
  [
    "prose before bullets",
    valid.replace("Key changes:\n", "Key changes:\nSee below.\n"),
    "followed by bullet",
  ],
  ["missing bullets", `${subject}\n\n${summary}\n\nKey changes:\n`, "at least one bullet"],
  [
    "blank between bullets",
    valid.replace("layout\n- Keep", "layout\n\n- Keep"),
    "between 'Key changes:' bullets",
  ],
  [
    "blank between wrapped bullets",
    valid.replace("body layout\n- Keep", "body\n  layout\n\n- Keep"),
    "between 'Key changes:' bullets",
  ],
  ["breaking marker without rebuild", withSubject("feat!: replace config"), "'Rebuild:' section"],
  [
    "breaking footer without rebuild",
    `${valid}\nBREAKING CHANGE: new config.\n`,
    "'Rebuild:' section",
  ],
  ["non-English subject", withSubject("docs: 更新规则"), "written in English"],
  ["non-English body", valid.replace(summary, "更新规则"), "written in English"],
];

for (const [name, message, diagnostic] of rejected) {
  test(`rejects ${name}`, () => {
    const errors = validateCommitMessage(message);
    assert.ok(
      errors.some((error) => error.includes(diagnostic)),
      errors.join("\n"),
    );
  });
}

test("the PR template follows the enforced commit body contract", () => {
  const body = readFileSync(
    new URL("../.github/pull_request_template.md", import.meta.url),
    "utf8",
  );
  assert.deepEqual(validateCommitMessage(`${subject}\n\n${body}`), []);
});

test("CLI reads the file and distinguishes success, invalid messages, and invocation errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-commit-test-"));
  const file = join(directory, "COMMIT_EDITMSG");
  const script = fileURLToPath(new URL("./check-commit-message.ts", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8" });
  try {
    writeFileSync(file, valid);
    const success = run(file);
    assert.equal(success.status, 0);
    assert.equal(success.stdout, "");
    assert.equal(success.stderr, "");

    writeFileSync(file, "docs: invalid\n");
    const invalid = run(file);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Key changes/u);

    assert.equal(run().status, 2);
    assert.equal(run(file, file).status, 2);
    const missing = run(join(directory, "missing"));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Cannot read/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
