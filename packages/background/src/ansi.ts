// Strip ANSI escape sequences from model- and user-facing text. Log files on
// disk keep the raw bytes; only notification tails and tool results are cleaned.
// Covers CSI, OSC (BEL- or ST-terminated), character set selection, and the
// remaining two-byte escapes. Applied to bounded tail text, not streams, so
// sequences split across chunks are not a concern here.
const ESC = "\u001B";
const CSI1 = "\u009B";
const BEL = "\u0007";
const ANSI_PATTERN = new RegExp(
  `[${ESC}${CSI1}]` +
    `(?:\\[[0-?]*[ -/]*[@-~]` + // CSI
    `|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)` + // OSC, BEL- or ST-terminated
    `|[()#][0-9A-Za-z]` + // character set selection
    `|[=>]|[@-Z\\\\-_])`, // remaining two-byte escapes
  "gu",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
