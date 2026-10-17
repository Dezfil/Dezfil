#!/usr/bin/env node
// The documentation's generator and gate.
//
// Write mode (`npm run docs:write`) generates what is made from the pages:
// the agents' index, docs/README.md. Check mode (`npm run lint:docs`) holds
// the page contract for every page under docs/ (the frontmatter, the
// headings, the links and pictures, the addresses each page owns and the old
// addresses it lists) and the generated files' freshness, and names each
// problem with its file and rule. The rules live in docs-contract.mjs.
//
// Usage:
//   node scripts/docs.mjs --check               # the repository
//   node scripts/docs.mjs --write               # regenerate the index
//   node scripts/docs.mjs --check --root <dir>  # another tree

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkIndex, checkTree, formatProblem, generateIndex, reader } from "./docs-contract.mjs";

const { values } = parseArgs({ options: { check: { type: "boolean" }, write: { type: "boolean" }, root: { type: "string" } } });
const root = path.resolve(values.root ?? process.cwd());

/** The files the repository holds: what git tracks plus new files it does
 * not ignore, so a page not yet added is checked too. Outside a git
 * checkout, every file under the root. */
function repositoryFiles() {
  try {
    const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
    if (path.resolve(top) === root) return [...new Set(listed.split("\0").filter(Boolean))].filter((file) => existsSync(path.join(root, file)));
  } catch { /* not a checkout of its own: walk the folder */ }
  const files = [];
  const walk = (folder) => {
    for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relative); else files.push(relative);
    }
  };
  walk("");
  return files;
}

const read = reader(root);
if (values.write) {
  writeFileSync(path.join(root, "docs/README.md"), generateIndex({ files: repositoryFiles(), read }));
  console.log("Wrote docs/README.md.");
}

const files = repositoryFiles();
const { problems, pages } = checkTree({ files, read });
problems.push(...checkIndex({ files, read }));
if (problems.length) {
  for (const p of problems) console.error(formatProblem(p));
  console.error(`FAIL: ${problems.length} documentation problem(s).`);
  process.exit(1);
}
console.log(`PASS: ${pages.length} pages hold the page contract and the index is current.`);
