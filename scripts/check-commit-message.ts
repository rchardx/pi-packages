import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Same message contract as trader, implemented without a Python toolchain.
const SUBJECT = /^(chore|docs|feat|fix|test|refactor)(?:\([a-z0-9._-]+\))?(!)?: .+$/u;
const BREAKING_FOOTER = /^BREAKING(?: |-)?CHANGE:/u;
const NON_ENGLISH =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{3ffff}]/u;
const SCISSORS = "# ------------------------ >8 ------------------------";

export function validateCommitMessage(message: string): string[] {
  const lines: string[] = [];
  for (const line of message.split(/\r?\n/u)) {
    if (line === SCISSORS) break;
    if (!line.startsWith("#")) lines.push(line.trimEnd());
  }
  while (lines.at(-1) === "") lines.pop();
  const subject = lines[0];
  if (subject === undefined) return ["commit message is empty"];

  const errors: string[] = [];
  if (lines.some((line) => NON_ENGLISH.test(line))) {
    errors.push("commit message must be written in English, subject and body alike");
  }
  const match = SUBJECT.exec(subject);
  if (!match) {
    errors.push(
      "subject must follow <type>[(scope)][!]: <subject>; allowed types: chore, docs, feat, fix, test, refactor",
    );
  }
  if ([...subject].length >= 72) errors.push("subject must be under 72 characters");

  const body = lines.slice(1);
  if (match?.[2] && !body.some(Boolean)) {
    errors.push("breaking commit marked with ! must include a body");
  }
  const section = body.indexOf("Key changes:");
  if (section === -1) {
    errors.push("body must include a 'Key changes:' section");
  } else {
    if (body[0] !== "") {
      errors.push("leave exactly one blank line between subject and body");
    }
    const summary = body.slice(1, section);
    if (section < 2 || !summary.some(Boolean)) {
      errors.push("body must include a summary paragraph before 'Key changes:'");
    } else {
      if (summary.at(-1) !== "" || summary.at(-2) === "") {
        errors.push("leave exactly one blank line between body summary and 'Key changes:'");
      }
      const paragraph = summary.at(-1) === "" ? summary.slice(0, -1) : summary;
      if (paragraph.includes("")) errors.push("body summary must be a single paragraph");
    }
    errors.push(...validateBullets(body.slice(section + 1)));
  }
  if (
    (match?.[2] || body.some((line) => BREAKING_FOOTER.test(line))) &&
    !body.join("\n").includes("Rebuild:")
  ) {
    errors.push("breaking change must include a 'Rebuild:' section");
  }
  return errors;
}

function validateBullets(lines: string[]): string[] {
  let bulletSeen = false;
  let blankSinceBullet = false;
  for (const line of lines) {
    if (line === "") {
      if (!bulletSeen) return ["do not leave a blank line after 'Key changes:'"];
      blankSinceBullet = true;
      continue;
    }
    const isBullet = /^[-*] /u.test(line);
    if (isBullet) {
      if (blankSinceBullet) {
        return ["do not leave blank lines between 'Key changes:' bullets"];
      }
      bulletSeen = true;
      continue;
    }
    if (!bulletSeen) return ["'Key changes:' must be followed by bullet lines"];
    if (blankSinceBullet) break;
  }
  return bulletSeen ? [] : ["'Key changes:' must include at least one bullet"];
}

export function main(args: string[]): number {
  const [path] = args;
  if (args.length !== 1 || !path) {
    console.error("usage: node --import tsx scripts/check-commit-message.ts COMMIT_MSG_FILE");
    return 2;
  }
  let message: string;
  try {
    message = readFileSync(path, "utf8");
  } catch {
    console.error(`Cannot read commit message file: ${path}`);
    return 2;
  }
  const errors = validateCommitMessage(message);
  if (errors.length === 0) return 0;
  console.error(`Commit message failed validation:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
