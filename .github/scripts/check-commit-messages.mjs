#!/usr/bin/env node
// Rejects a commit message that carries an internal tracking reference from
// the project's development history. Those references point at documents this
// repository does not publish, so in a public log they are noise at best and a
// leak of process detail at worst.
//
// Reads commit messages on stdin, one message per record, records separated by
// a NUL byte. That is the format `git log -z --format=%B` produces.
//
// Exits 0 when every message is clean, 1 when any message matches.

const rules = [
  {
    name: "a planning document number",
    pattern: /\bspecs?\s+\d{4}\b/i,
    advice: "Say what the change does instead of pointing at a numbered document.",
  },
  {
    name: "a tracking row identifier",
    pattern: /(?<![A-Za-z0-9])N-\d+(?![A-Za-z0-9])/,
    advice: "Reference a public issue number instead, or describe the defect.",
  },
  {
    name: "a path this repository does not carry",
    pattern: /\b(?:sdd\/\d|docs\/phases\/|docs\/known-issues|design\/prototypes\/|phase-\d)/i,
    advice: "Link something a reader of this repository can open, or drop the link.",
  },
];

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const messages = Buffer.concat(chunks)
  .toString("utf8")
  .split("\0")
  .map((m) => m.trim())
  .filter(Boolean);

if (messages.length === 0) {
  console.log("No commit messages to check.");
  process.exit(0);
}

let failed = 0;
for (const message of messages) {
  const subject = message.split("\n", 1)[0];
  for (const rule of rules) {
    const hit = message.match(rule.pattern);
    if (!hit) continue;
    failed += 1;
    console.error(`Commit message carries ${rule.name}: "${hit[0]}"`);
    console.error(`  in: ${subject}`);
    console.error(`  ${rule.advice}`);
    console.error("");
  }
}

if (failed > 0) {
  console.error(
    `${failed} problem${failed === 1 ? "" : "s"} found. Reword the commits with "git rebase -i" and force-push the branch.`,
  );
  process.exit(1);
}

console.log(`Checked ${messages.length} commit message${messages.length === 1 ? "" : "s"}: clean.`);
