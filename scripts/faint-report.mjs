#!/usr/bin/env node
/*
 * The faint ink's uses and the fades over text, folder by folder: each use
 * with where it is set, the kind src/faint-boundary.allowed.json lists it
 * under and what it shows, then what the faint boundary would fail on
 * (an unlisted use, a stale row, a kind that no longer holds).
 *
 * Usage:
 *   node scripts/faint-report.mjs                    # every folder
 *   node scripts/faint-report.mjs components/builder # one folder and below
 *
 * Exits non-zero when the list cannot be read or a finding stands.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect, faintUses, judge } from "./faint-uses.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIST = path.join(ROOT, "src", "faint-boundary.allowed.json");

let allowed;
try {
  allowed = JSON.parse(readFileSync(LIST, "utf8"));
} catch (error) {
  console.error(`Cannot read ${path.relative(ROOT, LIST)}: ${error.message}`);
  process.exit(2);
}

const wanted = (process.argv[2] ?? "").replace(/^\.\//, "").replace(/^src\//, "").replace(/\/$/, "");
const folderOf = (file) => path.posix.dirname(file).replace(/^src\//, "");
const inScope = (file) => !wanted || folderOf(file) === wanted || folderOf(file).startsWith(wanted + "/");
const clip = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const found = faintUses(collect({ root: ROOT }));
const kindOf = new Map(allowed.map((row) => [row.layer + " :: " + row.id, row.kind]));
const uses = [...found.uses.entries()].filter(([, use]) => inScope(use.file));
const findings = judge(found, { allowed }).filter((f) => inScope(f.key.split(" :: ")[1] ?? ""));

const byFolder = new Map();
for (const [key, use] of uses) {
  const folder = folderOf(use.file);
  if (!byFolder.has(folder)) byFolder.set(folder, []);
  byFolder.get(folder).push([key, use]);
}
for (const folder of [...byFolder.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
  console.log(`\n${folder}`);
  const lines = byFolder.get(folder).map(([key, use]) => {
    const shows = [...new Set(use.shows)].slice(0, 3).map((s) => clip(s));
    const where = use.id.split(" :: ").slice(1).join(" :: ");
    return { at: `${use.file}:${use.line}`, text: `${use.layer}  ${where}  ${use.value}  [${kindOf.get(key) ?? "not listed"}]${shows.length ? `\n      shows ${shows.join(" | ")}` : ""}` };
  });
  for (const line of lines.sort((a, b) => a.at.localeCompare(b.at, "en", { numeric: true }))) console.log(`  ${line.at}  ${line.text}`);
}
if (findings.length) {
  console.log("\nFindings");
  for (const f of findings) console.log(`  ${f.check}: ${f.message}`);
}

const ink = uses.filter(([, use]) => use.layer === "ink").length;
const scope = wanted ? ` under ${wanted}` : "";
console.log(`\n${ink} faint ink use(s) and ${uses.length - ink} fade(s)${scope}, ${findings.length} finding(s).`);
process.exit(findings.length ? 1 : 0);
