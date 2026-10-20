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
// The rules measure the page as Markdown parses (CommonMark with GitHub's
// extensions, the parser family the site renders with), never as groups of
// lines between blank ones. Prose is the text of paragraphs, of list items
// (each item's own text, counted once, a nested item as an item of its own)
// and of notices. Headings, tables, code blocks, HTML and the regions a
// generator writes between `<!-- name:start -->` and `<!-- name:end -->`
// are not prose. A link counts its text, not its destination; inline code
// counts as words; a picture's alternative text does not. Words are runs of
// letters and digits. The lines of a tab set (`::::tabs`, `:::tab[Label]`,
// `:::` and `::::`) are not prose; what the tabs hold is.
//
// Each problem names the file, the rule and the line, in the page
// contract's form. The rule names are stable: the cases refer to them.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { placeOf, splitPage } from "./docs-contract.mjs";

/** The list of pages not yet rewritten, one page path per line. */
export const WRITING_LIST = "scripts/docs-not-rewritten.txt";

const problem = (file, rule, message, line) => ({ file, rule, message, ...(line ? { line } : {}) });

// ---------------------------------------------------------------------------
// Reading a body

/** A body parsed as GitHub parses Markdown. */
export const parseMarkdown = (text) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/** A text's words: its runs of letters and digits. */
export const words = (text) => text.match(WORD) ?? [];

/** The median of a list of numbers; of an even count, the mean of the two
 * middle values. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Visit a node and everything under it, depth first, in document order,
 * with the node's ancestors. Returning false skips a node's children. */
function walk(node, visit, ancestors = []) {
  if (visit(node, ancestors) === false) return;
  for (const child of node.children ?? []) walk(child, visit, [...ancestors, node]);
}

/** What a line that opens with three or more colons is in the authoring
 * syntax: one of the four lines of a tab set, a tab line of another shape,
 * or a block of another kind (a notice the site's generator would draw).
 * Null for a line that is none of these. */
export function colonLine(text) {
  const line = text.trim();
  if (!/^:{3,}/.test(line)) return null;
  if (line === "::::tabs") return { kind: "set-open" };
  const tab = /^:::tab(?:\[(.*)\])?$/.exec(line);
  if (tab) return { kind: "tab-open", label: (tab[1] ?? "").trim() };
  if (line === ":::") return { kind: "tab-close" };
  if (line === "::::") return { kind: "set-close" };
  if (/^:{3,}(?:tabs?\b|$)/.test(line)) return { kind: "tab-form", text: line };
  if (/^:{3,}[A-Za-z]/.test(line)) return { kind: "block", text: line };
  return null;
}

const GENERATED_START = /^<!--\s*([A-Za-z0-9_-]+):start\s*-->$/;
const GENERATED_END = /^<!--\s*([A-Za-z0-9_-]+):end\s*-->$/;

/** A body read for the writing rules. Lines of the tab syntax outside code
 * are found first and blanked, keeping the line count, so a tab line
 * neither joins the paragraph or notice beside it nor counts as prose; the
 * rest is then parsed. `firstLine` is the body's first line in its file,
 * and every line the reading gives is a line of the file. */
export function readBody(body, firstLine = 1) {
  const lines = body.split("\n");
  const code = new Set();
  walk(parseMarkdown(body), (node) => {
    if (node.type !== "code") return;
    for (let line = node.position.start.line; line <= node.position.end.line; line += 1) code.add(line);
  });
  const markers = [];
  const blanked = lines.map((text, i) => {
    const marker = code.has(i + 1) ? null : colonLine(text);
    if (!marker) return text;
    markers.push({ ...marker, line: firstLine + i, index: i });
    return "";
  });
  const tree = parseMarkdown(blanked.join("\n"));
  const regions = [];
  const open = new Map();
  walk(tree, (node) => {
    if (node.type !== "html") return;
    const value = node.value.trim();
    const start = GENERATED_START.exec(value), end = GENERATED_END.exec(value);
    if (start) open.set(start[1], node.position.start.line);
    else if (end && open.has(end[1])) {
      regions.push([open.get(end[1]), node.position.end.line]);
      open.delete(end[1]);
    }
  });
  const at = (node) => firstLine + node.position.start.line - 1;
  const generated = (node) => regions.some(([from, to]) => node.position.start.line >= from && node.position.start.line <= to);
  return { tree, lines, markers, at, generated, firstLine };
}

// ---------------------------------------------------------------------------
// Prose

/** The words of inline content, each with its file line and its place in
 * the body (for document order). Text and inline code count; a link
 * counts its text; a picture, HTML and a footnote mark do not. `skip`
 * leaves out a leading part of the first text, such as a notice's marker. */
function inlineWords(node, read, skip = 0) {
  const found = [];
  let skipping = skip;
  const visit = (n) => {
    if (n.type === "text" || n.type === "inlineCode") {
      const from = skipping;
      skipping = 0;
      for (const match of n.value.slice(from).matchAll(WORD)) {
        const index = from + match.index;
        const newlines = n.type === "text" ? n.value.slice(0, index).split("\n").length - 1 : 0;
        found.push({ line: read.at(n) + newlines, key: n.position.start.offset + index });
      }
      return;
    }
    if (["image", "imageReference", "html", "footnoteReference", "break"].includes(n.type)) return;
    for (const child of n.children ?? []) visit(child);
  };
  visit(node);
  return found;
}

const NOTICE_MARKER = /^\[!([A-Za-z]+)\]/;

/** A notice's marker: the kind its first line names (`[!NOTE]`), and
 * whether the marker stands alone on that line as GitHub requires. Null
 * when the quote opens with no marker. */
export function noticeMarker(quote) {
  const first = quote.children[0];
  const text = first?.type === "paragraph" && first.children[0]?.type === "text" ? first.children[0].value : "";
  const marker = NOTICE_MARKER.exec(text);
  if (!marker) return null;
  return { kind: marker[1].toUpperCase(), alone: text.split("\n")[0].trim() === marker[0], length: marker[0].length };
}

/** A notice's words: the text of everything it holds but code, tables and
 * HTML, without its marker. */
function noticeWords(quote, read) {
  const marker = noticeMarker(quote);
  const found = [];
  let first = true;
  walk(quote, (node) => {
    if (["code", "table", "html"].includes(node.type)) return false;
    if (node.type !== "paragraph") return;
    found.push(...inlineWords(node, read, first && marker ? marker.length : 0));
    first = false;
    return false;
  });
  return found;
}

/** A body's prose: one unit per paragraph, list item and notice, each with
 * its kind, its file line and its words, and every word of the prose in
 * document order. A list item's unit holds its own paragraphs; a list
 * nested in it gives units of its own. A notice is one unit, whatever it
 * holds. Units inside a generated region are left out. */
export function measure(body, firstLine = 1, read = readBody(body, firstLine)) {
  const units = [];
  const unit = (kind, node, found) => units.push({ kind, line: read.at(node), words: found.length, found });
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (read.generated(child)) continue;
      if (child.type === "paragraph") unit("paragraph", child, inlineWords(child, read));
      else if (child.type === "listItem") {
        const own = child.children.filter((c) => c.type === "paragraph");
        if (own.length) unit("item", child, own.flatMap((p) => inlineWords(p, read)));
        visit({ children: child.children.filter((c) => c.type !== "paragraph") });
      } else if (child.type === "blockquote") unit("notice", child, noticeWords(child, read));
      else if (!["code", "html", "table", "heading", "definition", "footnoteDefinition"].includes(child.type)) visit(child);
    }
  };
  visit(read.tree);
  const all = units.flatMap((u) => u.found).sort((a, b) => a.key - b.key);
  return { units, words: all, read };
}

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
