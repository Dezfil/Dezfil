#!/usr/bin/env node
// The documentation's generator and gate.
//
// Write mode (`npm run docs:write`) generates what is made from the pages
// and the source: the agents' index, docs/README.md; the API description
// file, docs/api/openapi.json, built from the same contract source the
// server serves, with no server; and the settings tables in their pages,
// built from the settings catalogue Settings reads. Check mode
// (`npm run lint:docs`) holds the page contract for every page under docs/
// (the frontmatter, the headings, the links and pictures, the addresses each
// page owns and the old addresses it lists), the writing rules for every
// page not on the list of pages not yet rewritten, the links and pictures of
// every procedure note under scripts/ and src/ (which are not pages), the
// image manifest against the files it lists, and the freshness of the
// generated files and of the settings tables, and names each problem with
// its file and rule. The rules live in docs-contract.mjs, docs-writing.mjs,
// docs-manifest.mjs and settings-tables.mjs.
//
// Usage:
//   node scripts/docs.mjs --check               # the repository
//   node scripts/docs.mjs --write               # regenerate what is generated
//   node scripts/docs.mjs --check --root <dir>  # another tree

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { contractSource } from "./contract-source.mjs";
import { DESCRIPTION_FILE, checkDescription, checkIndex, checkTree, descriptionText, formatProblem, generateIndex, reader } from "./docs-contract.mjs";
import { checkManifest } from "./docs-manifest.mjs";
import { checkWriting, writingNames } from "./docs-writing.mjs";
import { settingsDisplaySource } from "./settings-source.mjs";
import { checkSettingsTables, settingsTables, writeSettingsTables } from "./settings-tables.mjs";

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
// A tree without the contract source (a fixture tree) has no description
// to hold; the repository always has one.
const hasSource = existsSync(path.join(root, "src/lib/api/openapi.ts"));
const document = hasSource ? (await contractSource(root)).document : null;
// The settings catalogue, and the tables made from it. A fixture tree
// without the source has neither.
const settings = existsSync(path.join(root, "src/lib/settings/catalogue.ts")) ? await settingsDisplaySource(root) : null;
const tables = settings ? settingsTables(settings) : [];
if (values.write) {
  if (document) {
    writeFileSync(path.join(root, DESCRIPTION_FILE), descriptionText(document));
    console.log(`Wrote ${DESCRIPTION_FILE}.`);
  }
  const written = writeSettingsTables({ files: repositoryFiles(), read, write: (file, text) => writeFileSync(path.join(root, file), text), tables });
  if (tables.length) console.log(`Wrote the settings tables${written.length ? ` in ${written.join(", ")}` : ", unchanged"}.`);
  writeFileSync(path.join(root, "docs/README.md"), generateIndex({ files: repositoryFiles(), read }));
  console.log("Wrote docs/README.md.");
}

const files = repositoryFiles();
const { problems, pages, notes, used } = checkTree({ files, read });
problems.push(...checkManifest({ files, read, readBytes: (file) => readFileSync(path.join(root, file)), used }));
// The names a read_when line is held to: the settings catalogue's and the
// description's error codes. A fixture tree without the source has none.
const catalogue = settings ? settings.catalogue.SETTING_CATALOGUE : [];
problems.push(...checkSettingsTables({ files, read, tables }));
const writing = checkWriting({ files, read, names: writingNames({ catalogue, document }) });
problems.push(...writing.problems);
problems.push(...checkIndex({ files, read }));
if (document) {
  const committed = existsSync(path.join(root, DESCRIPTION_FILE)) ? readFileSync(path.join(root, DESCRIPTION_FILE), "utf8") : null;
  problems.push(...checkDescription({ committed, document }));
}
if (problems.length) {
  for (const p of problems) console.error(formatProblem(p));
  console.error(`FAIL: ${problems.length} documentation problem(s).`);
  process.exit(1);
}
const media = files.includes("docs/images/manifest.json") ? " The image manifest matches its files." : "";
const listed = writing.listed.length ? `, ${writing.listed.length} on the list of pages not yet rewritten` : "";
const current = [document ? "the API description file" : null, tables.length ? `the ${tables.length} settings tables` : null].filter(Boolean);
console.log(`PASS: ${pages.length} pages hold the page contract; ${writing.checked.length} hold the writing rules${listed}; the links in ${notes.length} procedure notes resolve; the index${current.length ? `, ${current.join(" and ")} are` : " is"} current.${media}`);
