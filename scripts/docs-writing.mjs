// The documentation's writing rules: how a page under docs/ is written, held
// by `npm run lint:docs` beside the page contract of docs-contract.mjs.
//
// The rules are the product's own. The documentation site keeps the page
// contract and does not repeat them, so the shared cases that hold them
// (test-support/docs-contract/cases.json, each marked "scope": "product")
// run here and are skipped there.
//
// While pages are being rewritten, the pages on the list beside this module
// (docs-not-rewritten.txt) are skipped by the writing rules; every other
// check of the lint still holds them. A page leaves the list in the change
// that rewrites it, and no page is added to it.
//
// Each problem names the file, the rule and the line, in the page
// contract's form. The rule names are stable: the cases refer to them.

import { placeOf, splitPage } from "./docs-contract.mjs";

/** The list of pages not yet rewritten, one page path per line. */
export const WRITING_LIST = "scripts/docs-not-rewritten.txt";

const problem = (file, rule, message, line) => ({ file, rule, message, ...(line ? { line } : {}) });

/** The list's entries with their lines: one path per line, with blank lines
 * and lines that begin with # left out. */
export function readList(text) {
  const entries = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line && !line.startsWith("#")) entries.push({ path: line, line: i + 1 });
  });
  return entries;
}

/** The writing rules over one page's text. The rules join here as they
 * are added. */
export function checkPageWriting() {
  return [];
}

/** Every writing problem in the tree: the list's own entries, then each
 * authored page off the list. Returns the problems, the pages the rules
 * read and the pages the list kept out. */
export function checkWriting({ files, read }) {
  const problems = [];
  const pages = files.filter((file) => placeOf(file).kind === "page").sort();
  const listed = new Set();
  if (files.includes(WRITING_LIST)) {
    for (const entry of readList(read(WRITING_LIST))) {
      if (!pages.includes(entry.path)) problems.push(problem(WRITING_LIST, "writing.list-entry", `${entry.path} is not a page under docs/`, entry.line));
      else if (listed.has(entry.path)) problems.push(problem(WRITING_LIST, "writing.list-entry", `${entry.path} is listed twice`, entry.line));
      else listed.add(entry.path);
    }
  }
  const checked = pages.filter((file) => !listed.has(file));
  for (const file of checked) {
    const text = read(file);
    const page = splitPage(text);
    if (page.error) continue;
    problems.push(...checkPageWriting({ file, text, page }));
  }
  return { problems, checked, listed: pages.filter((file) => listed.has(file)) };
}
