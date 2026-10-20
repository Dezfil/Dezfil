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
// lines between blank ones. Prose is the text of paragraphs (a footnote's
// included), of list items (each item's own text, counted once, a nested
// item as an item of its own) and of notices. Headings, tables, code blocks, HTML and the regions a
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

/** The text of inline content as it reads: text and inline code. */
const plainText = (node) => (typeof node.value === "string" && ["text", "inlineCode"].includes(node.type) ? node.value : (node.children ?? []).map(plainText).join(""));

/** A heading that begins with a step number: "Step 1" or "1." */
const STEP_HEADING = /^(?:step\s+\d+(?![\p{L}\p{N}])|\d+[.)](?:\s|$))/iu;

/** What a reader can do or see: a code block, a picture or recording (a
 * picture's syntax, by reference or in HTML), a table, a numbered list (its
 * first item is step 1) or a heading that begins with a step number. */
function isSomethingToDo(node) {
  if (["code", "table", "image", "imageReference"].includes(node.type)) return true;
  if (node.type === "list") return node.ordered === true;
  if (node.type === "heading") return STEP_HEADING.test(plainText(node).trim());
  if (node.type === "html") return /<(?:img|video)\b/i.test(node.value);
  return false;
}

/** A body's prose: one unit per paragraph, list item and notice, each with
 * its kind, its file line and its words, and every word of the prose in
 * document order. A list item's unit holds its own paragraphs; a list
 * nested in it gives units of its own. A notice is one unit, whatever it
 * holds. A footnote's paragraphs are paragraphs. Units inside a generated
 * region are left out. Beside the prose, the things a reader can do or
 * see, in the same order. */
export function measure(body, firstLine = 1, read = readBody(body, firstLine)) {
  const units = [];
  const unit = (kind, node, found) => units.push({ kind, line: read.at(node), words: found.length, found, node });
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (read.generated(child)) continue;
      if (child.type === "paragraph") unit("paragraph", child, inlineWords(child, read));
      else if (child.type === "listItem") {
        const own = child.children.filter((c) => c.type === "paragraph");
        if (own.length) unit("item", child, own.flatMap((p) => inlineWords(p, read)));
        visit({ children: child.children.filter((c) => c.type !== "paragraph") });
      } else if (child.type === "blockquote") unit("notice", child, noticeWords(child, read));
      else if (!["code", "html", "table", "heading", "definition"].includes(child.type)) visit(child);
    }
  };
  visit(read.tree);
  const all = units.flatMap((u) => u.found).sort((a, b) => a.key - b.key);
  const shown = [];
  walk(read.tree, (node) => {
    if (node.position && isSomethingToDo(node)) shown.push({ kind: node.type, line: read.at(node), key: node.position.start.offset });
  });
  return { units, words: all, shown, read };
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

// ---------------------------------------------------------------------------
// The rules

/** The numbers the rules hold a page to. */
export const LIMITS = {
  /** Words in a paragraph, a list item or a notice. */
  block: 80,
  /** The median paragraph's words, on a page with `medianFrom` paragraphs or more. */
  median: 30,
  medianFrom: 5,
  /** Words of prose on a page. */
  page: 1500,
  /** Words of prose a reader passes before something to do or see. */
  firstScreen: 150,
  /** Words in a notice. */
  notice: 50,
};

/** The two kinds of notice, in GitHub's alert form. */
export const NOTICE_KINDS = ["NOTE", "WARNING"];

/** The scripts the image ships for operators to run, which a page outside
 * Contribute may name: the account recovery script. */
export const OPERATOR_SCRIPTS = ["scripts/admin-recover.mjs"];

/** The sections whose pages open with something to do or see. */
export const FIRST_SCREEN_SECTIONS = ["start", "use", "self-host", "api"];

const UNIT_NAME = { paragraph: "paragraph", item: "list item", notice: "notice" };

/** A code block's title as the site reads it after the language: in
 * double quotes as the sample pages write it (`title="Terminal"`), in
 * single quotes, or as one unquoted word. */
const CODE_TITLE = /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)'|(?!["'])(\S+))/i;

/** A code block's title, or null when it has none. */
function codeTitle(node) {
  const title = CODE_TITLE.exec([node.lang ?? "", node.meta ?? ""].join(" "));
  const value = title ? (title[1] ?? title[2] ?? title[3]).trim() : "";
  return value && !(title[3] && ["true", "false"].includes(value)) ? value : null;
}

/** The problems of a code block: its language and its title. A block
 * whose info string opens with the title holds no language. */
function codeProblems(node, read) {
  const found = [];
  const lang = node.lang ?? "";
  if (!lang || /^title\s*=/i.test([lang, node.meta ?? ""].join(" "))) found.push({ rule: "writing.code-language", message: "this code block names no language: open it with one, such as ```sh title=\"Terminal\"", line: read.at(node) });
  if (!codeTitle(node)) found.push({ rule: "writing.code-title", message: "this code block has no title: name it after the language, such as ```sh title=\"Terminal\"", line: read.at(node) });
  return found;
}

/** The problems of a body's tab sets. A set opens with a `::::tabs` line
 * and closes with a `::::` line; between them stand two or more tabs, each
 * opened by a `:::tab[Label]` line with a label of its own and closed by a
 * `:::` line, and nothing else. A `:::` line inside a tab may close a block
 * of another kind that opened there; the notice rule names that block. */
function tabProblems(read) {
  const found = [];
  const add = (rule, message, index) => found.push({ rule, message, line: read.firstLine + index });
  const at = new Map(read.markers.map((marker) => [marker.index, marker]));
  let set = null;
  let blocks = 0;
  read.lines.forEach((text, i) => {
    const marker = at.get(i);
    if (!marker) {
      if (set && !set.tab && !set.stray && text.trim() !== "") {
        add("writing.tabs-outside", "this stands inside a tab set but outside its tabs; put it in a tab, or after the set's closing :::: line", i);
        set.stray = true;
      }
      return;
    }
    if (marker.kind === "block") blocks += 1;
    else if (marker.kind === "tab-close" && blocks > 0) blocks -= 1;
    else if (marker.kind === "tab-form") add("writing.tabs-form", `"${marker.text}" is not a line of a tab set, which takes ::::tabs, :::tab[Label], ::: and ::::`, i);
    else if (marker.kind === "set-open") {
      if (set) add("writing.tabs-form", "a tab set cannot open inside another", i);
      else set = { index: i, labels: [], tab: null, stray: false };
    } else if (marker.kind === "tab-open") {
      if (!set) return add("writing.tabs-form", "a :::tab line stands only inside a tab set opened by a ::::tabs line", i);
      if (set.tab) add("writing.tabs-unclosed", "this tab is not closed by a ::: line before the next tab opens", set.tab);
      if (!marker.label) add("writing.tabs-label", "this tab has no label: open it with :::tab[Label]", i);
      else if (set.labels.includes(marker.label)) add("writing.tabs-label", `the set already holds a tab labelled ${marker.label}`, i);
      set.labels.push(marker.label);
      set.tab = i;
      set.stray = false;
    } else if (marker.kind === "tab-close") {
      if (set?.tab !== null && set?.tab !== undefined) {
        set.tab = null;
        set.stray = false;
      } else add("writing.tabs-form", "a ::: line closes a tab, and no tab is open here", i);
    } else if (marker.kind === "set-close") {
      if (!set) return add("writing.tabs-form", "a :::: line closes a tab set, and no set is open here", i);
      if (set.tab !== null) add("writing.tabs-unclosed", "this tab is not closed by a ::: line before its set closes", set.tab);
      if (set.labels.length < 2) add("writing.tabs-count", `this tab set holds ${set.labels.length} tab${set.labels.length === 1 ? "" : "s"}; a set holds two or more`, set.index);
      set = null;
    }
  });
  if (set) {
    if (set.tab !== null) add("writing.tabs-unclosed", "this tab is never closed by a ::: line", set.tab);
    add("writing.tabs-unclosed", "this tab set is never closed by a :::: line", set.index);
  }
  return found;
}

/** The problems of a body's notices: each a GitHub NOTE or WARNING
 * alert, its marker alone on its first line, of at most 50 words, and at
 * most one in a second-level section. A quote of any other form and a
 * colon block (`:::note`) are other forms of notice. */
function noticeProblems(prose) {
  const found = [];
  const { read } = prose;
  const add = (rule, message, line) => found.push({ rule, message, line });
  const words = new Map(prose.units.filter((unit) => unit.kind === "notice").map((unit) => [unit.line, unit.words]));
  const sections = [];
  walk(read.tree, (node) => {
    if (node.type === "heading" && node.depth === 2) sections.push(read.at(node));
  });
  const counted = new Map();
  walk(read.tree, (node) => {
    if (node.type !== "blockquote") return;
    if (read.generated(node)) return false;
    const line = read.at(node);
    const marker = noticeMarker(node);
    if (!marker) add("writing.notice-kind", "a quote is another form of notice; write a notice as a > [!NOTE] or > [!WARNING] alert", line);
    else if (!marker.alone) add("writing.notice-kind", `the [!${marker.kind}] marker shares its line with text, so GitHub shows a plain quote; put the marker on a line of its own`, line);
    else if (!NOTICE_KINDS.includes(marker.kind)) add("writing.notice-kind", `a [!${marker.kind}] alert is another form of notice; a notice is a NOTE or a WARNING alert`, line);
    const count = words.get(line) ?? 0;
    if (count > LIMITS.notice) add("writing.notice-length", `this notice is ${count} words; one holds at most ${LIMITS.notice}, a sentence or two`, line);
    const section = sections.filter((heading) => heading < line).at(-1) ?? 0;
    counted.set(section, (counted.get(section) ?? 0) + 1);
    if (counted.get(section) > 1) add("writing.notice-count", "this is the section's second notice; a second-level section holds at most one", line);
    return false;
  });
  for (const marker of read.markers.filter((m) => m.kind === "block")) {
    add("writing.notice-kind", `"${marker.text}" opens a block of another form; write a notice as a > [!NOTE] or > [!WARNING] alert`, marker.line);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Words

/** What breaks a text where code or bold stood, so no phrase reads across. */
const GAP = "\u0000";

/** Whether a link's text is its own address: an address in angle
 * brackets or written bare, which GitHub links as it stands (a www or mail
 * address gains its scheme). */
const isAddress = (link) =>
  link.children.length === 1 && link.children[0].type === "text" &&
  [link.url, link.url.replace(/^mailto:/, ""), link.url.replace(/^http:\/\//, "")].includes(link.children[0].value);

/** A block's inline content as one text, with each character's file line.
 * `code` keeps inline code (else a gap stands for it), `strong` keeps bold
 * text (else a gap), `urls` keeps a link whose text is its own address
 * (else a gap), `alt` keeps a picture's alternative text (else a gap). A
 * link gives its text; HTML gives a gap. */
function flatten(node, read, { code, strong, urls = true, alt = true }) {
  let text = "";
  const lines = [];
  const append = (value, line, multiline) => {
    for (let i = 0; i < value.length; i += 1) {
      text += value[i];
      lines.push(line);
      if (multiline && value[i] === "\n") line += 1;
    }
  };
  const visit = (n) => {
    if (n.type === "text") append(n.value, read.at(n), true);
    else if (n.type === "inlineCode") append(code ? `${GAP}${n.value}${GAP}` : GAP, read.at(n), false);
    else if (n.type === "strong" && !strong) append(GAP, read.at(n), false);
    else if (n.type === "link" && !urls && isAddress(n)) append(GAP, read.at(n), false);
    else if (n.type === "image" || n.type === "imageReference") append(alt ? ` ${n.alt ?? ""} ` : GAP, read.at(n), false);
    else if (n.type === "html") append(GAP, read.at(n), false);
    else if (n.type === "break") append("\n", read.at(n), false);
    else for (const child of n.children ?? []) visit(child);
  };
  for (const child of node.children ?? []) visit(child);
  return { text, lines };
}

/** A label the site shows as text, on one line. */
const label = (text, line) => ({ text, lines: Array(text.length).fill(line) });

/** The page's texts outside code blocks, HTML and generated regions: each
 * paragraph, heading and table cell flattened as `flatten` says, and the
 * labels the site shows beside them, each code block's title and each
 * tab's label. */
function texts(read, keep) {
  const found = [];
  walk(read.tree, (node) => {
    if (node.position && read.generated(node)) return false;
    if (node.type === "code") {
      const title = codeTitle(node);
      if (title) found.push(label(title, read.at(node)));
      return false;
    }
    if (["html", "definition"].includes(node.type)) return false;
    if (["paragraph", "heading", "tableCell"].includes(node.type)) {
      found.push(flatten(node, read, keep));
      return false;
    }
  });
  for (const marker of read.markers) if (marker.kind === "tab-open" && marker.label) found.push(label(marker.label, marker.line));
  return found;
}

/** Each line of each code block outside generated regions, with its file
 * line. A fenced block's content starts on the line after its fence; the
 * fence is read where the block starts, past the markers of the notice or
 * list item that holds it. */
function codeLines(read) {
  const found = [];
  walk(read.tree, (node) => {
    if (node.type !== "code" || read.generated(node)) return;
    const { line, column } = node.position.start;
    const fenced = /^(?:`{3,}|~{3,})/.test((read.lines[line - 1] ?? "").slice(column - 1));
    node.value.split("\n").forEach((text, i) => found.push({ text, line: read.at(node) + (fenced ? 1 : 0) + i }));
  });
  return found;
}

/** A phrase as a message names it: on one line, a page's line breaks
 * inside it read as spaces. */
const oneLine = (text) => text.replace(/\s+/g, " ");

/** A whole word or phrase, its words apart by any space, in any case. */
const phrase = (words) => new RegExp(`(?<![\\p{L}\\p{N}])${words.split(" ").join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");

/** The words that tell a history or what is not promised. */
const HISTORY = ["now", "previously", "no longer", "is not claimed", "does not establish", "is not promised"].map((words) => ({ words, pattern: phrase(words) }));
const USED_TO = phrase("used to");
/** The forms of "be" that make "used to" a description: "is used to". */
const BE = new Set(["be", "is", "are", "was", "were", "been", "being", "am", "isn't", "aren't", "wasn't", "weren't"]);
/** Words that may stand between the form of "be" and "used to". */
const BETWEEN = new Set(["not", "also", "often", "still", "only", "always", "never", "sometimes", "mostly", "rarely", "all", "both", "mainly"]);
const isBe = (word) => BE.has(word) || /'(?:s|re|m)$/.test(word);

/** Whether "used to" at `index` follows a form of "be", with at most two
 * adverbs between ("is not always used to"). */
function afterBe(text, index) {
  const before = (text.slice(Math.max(0, index - 80), index).toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []);
  for (let between = 0; between <= 2 && between < before.length; between += 1) {
    const middle = before.slice(before.length - between);
    if (!middle.every((word) => BETWEEN.has(word) || word.endsWith("ly"))) return false;
    if (isBe(before[before.length - 1 - between])) return true;
  }
  return false;
}

/** The development record's terms, kept out of every page outside
 * Contribute. */
const RECORD_TERMS = /(?<![\p{L}\p{N}])(?:proofs?|probes?|seeds?|seeded|red-proven|gates?|specs?)(?![\p{L}\p{N}])/giu;

/** A repository path a reader outside Contribute never needs: one that
 * begins with a source, test or tooling folder, or a script the image does
 * not ship for operators. */
const REPOSITORY_PATH = /(?:^|[\s'"\x60(<[=:,\u0000])(?:\.{1,2}\/)*((?:src|e2e|test-support|\.github|\.claude|scripts)\/[^\s'"\x60)<>\]\u0000]*)/g;
const CHECK_COMMAND = /(?<![\w-])npm\s+(?:test(?![\w:-])|run(?:-script)?\s+(?:test|lint|docs)[\w:.-]*)/g;
const TEST_SETTING = /(?<![A-Za-z0-9_])DEZFIL_TEST_[A-Za-z0-9_]*/g;

/** The problems of the paths, commands and settings a text names. */
function namedProblems(text, lineAt) {
  const found = [];
  for (const match of text.matchAll(REPOSITORY_PATH)) {
    const path = match[1].replace(/[.,;:!?]+$/, "");
    if (OPERATOR_SCRIPTS.includes(path)) continue;
    const message = path.startsWith("scripts/")
      ? `${path} is a script the image does not ship for operators; outside Contribute a page names only ${OPERATOR_SCRIPTS.join(", ")}`
      : `${path} is a path in the repository's source, tests or tooling; outside Contribute a page does not name one`;
    found.push({ rule: "writing.repository-path", message, line: lineAt(match.index + match[0].indexOf(match[1])) });
  }
  for (const match of text.matchAll(CHECK_COMMAND)) {
    found.push({ rule: "writing.check-command", message: `${match[0].replace(/\s+/g, " ")} runs the project's checks or tests; outside Contribute a page does not name them`, line: lineAt(match.index) });
  }
  for (const match of text.matchAll(TEST_SETTING)) {
    found.push({ rule: "writing.test-setting", message: `${match[0]} is test wiring; outside Contribute a page does not name it`, line: lineAt(match.index) });
  }
  return found;
}

// ---------------------------------------------------------------------------
// The names a read_when line is held to

/** The variables and Settings keys the settings tables document, read from
 * the settings catalogue they are made from, and the error codes of the
 * API description's catalogue. A Settings key is one an admin changes in
 * Settings; an account's own preferences and the test wiring are not
 * settings the tables document. */
export function writingNames({ catalogue = [], document = null } = {}) {
  const variables = [...new Set(catalogue.filter((setting) => setting.environment).map((setting) => setting.environment))];
  const keys = catalogue.filter((setting) => setting.editable && setting.scope !== "account").map((setting) => setting.key);
  const codes = Object.keys(document?.["x-error-codes"] ?? {});
  return { variables, keys, codes };
}

const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name that reads as an ordinary word, such as the error codes
 * forbidden and internal: a line names it only where it sets it as code. */
const PLAIN_WORD = /^\p{Ll}+$/u;

/** The names a line of text gives, of those `kinds` holds: each token that
 * is one, but a plain word only inside backticks. */
function namesIn(line, kinds) {
  const code = [...line.matchAll(/`[^`]*`/g)].map((m) => [m.index, m.index + m[0].length]);
  const found = [];
  for (const match of line.matchAll(/[A-Za-z0-9_.]+/g)) {
    const name = match[0].replace(/^\.+|\.+$/g, "");
    if (!kinds.has(name)) continue;
    if (PLAIN_WORD.test(name) && !code.some(([from, to]) => match.index > from && match.index < to)) continue;
    found.push(name);
  }
  return found;
}

/** The problems of a page's read_when lines: every variable, Settings key
 * and error code a line names appears in the page's body outside HTML
 * comments, which no reader sees, so the page answers the situation it
 * names. Each is named at its read_when line. */
function readWhenProblems({ text, page, names }) {
  const found = [];
  const kinds = new Map([...names.codes.map((name) => [name, "error code"]), ...names.keys.map((name) => [name, "Settings key"]), ...names.variables.map((name) => [name, "variable"])]);
  const list = Array.isArray(page.data?.read_when) ? page.data.read_when : [];
  if (!kinds.size || !list.length) return found;
  const front = text.split("\n").slice(0, page.bodyLine - 1);
  const from = Math.max(0, front.findIndex((line) => /^read_when\s*:/.test(line)));
  const body = page.body.replace(/<!--[\s\S]*?-->/g, " ");
  const reported = new Set();
  for (const line of list) {
    if (typeof line !== "string") continue;
    for (const name of namesIn(line, kinds)) {
      if (reported.has(name)) continue;
      if (new RegExp(`(?<![A-Za-z0-9_.])${escapeName(name)}(?![A-Za-z0-9_])`).test(body)) continue;
      reported.add(name);
      const at = front.findIndex((entry, i) => i >= from && namesIn(entry, kinds).includes(name));
      found.push({ rule: "writing.read-when-name", message: `a read_when line names the ${kinds.get(name)} ${name}, and the page's body never does; answer it on the page, or leave it out of the line`, line: (at === -1 ? from : at) + 1 });
    }
  }
  return found;
}

/** Problems in file order: by line, then by rule. */
const byPlace = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));

/** The writing rules over one page: `text` is the page's file, `page` the
 * page split into its frontmatter and body as the page contract splits it,
 * and `names` the names its read_when lines are held to. */
export function checkPageWriting({ file, text = "", page, names = writingNames() }) {
  const problems = [];
  const add = (rule, message, line) => problems.push(problem(file, rule, message, line));
  const section = file.split("/")[1];
  const prose = measure(page.body, page.bodyLine);

  // No paragraph, list item or notice over its length.
  for (const unit of prose.units) {
    if (unit.words > LIMITS.block) add("writing.paragraph-length", `this ${UNIT_NAME[unit.kind]} is ${unit.words} words; one holds at most ${LIMITS.block}`, unit.line);
  }

  // The median paragraph, over the paragraphs that hold words: a list item
  // or a notice is not a paragraph, and a picture alone holds none.
  const paragraphs = prose.units.filter((unit) => unit.kind === "paragraph" && unit.words > 0);
  if (paragraphs.length >= LIMITS.medianFrom) {
    const middle = median(paragraphs.map((unit) => unit.words));
    if (middle > LIMITS.median) {
      const first = paragraphs.find((unit) => unit.words > LIMITS.median);
      add("writing.median-paragraph", `the median of the page's ${paragraphs.length} paragraphs is ${middle} words, over ${LIMITS.median}; this is the first longer than ${LIMITS.median}`, first.line);
    }
  }

  // The page's prose, named at the line of the first word over.
  if (prose.words.length > LIMITS.page) {
    add("writing.page-length", `the page holds ${prose.words.length} words of prose, over ${LIMITS.page}, and word ${LIMITS.page + 1} is on this line; split the subject into an overview and a page per area`, prose.words[LIMITS.page].line);
  }

  // Every code block names its language and a title.
  walk(prose.read.tree, (node) => {
    if (node.type !== "code" || prose.read.generated(node)) return;
    for (const found of codeProblems(node, prose.read)) add(found.rule, found.message, found.line);
  });

  // Every tab set well formed.
  for (const found of tabProblems(prose.read)) add(found.rule, found.message, found.line);

  // Notices: their form, their length and one to a section.
  for (const found of noticeProblems(prose)) add(found.rule, found.message, found.line);

  // Outside code and bold: no em dash, no word of a history or of what is
  // not promised and, outside Contribute, no term of the record. The words
  // are the page's own, so an address that is its own link text is not
  // read for them; nor is a picture's text, which cannot set a UI label in
  // bold, so it reads like bold.
  for (const { text, lines } of texts(prose.read, { code: false, strong: false })) {
    for (const match of text.matchAll(/\u2014/g)) add("writing.em-dash", "an em dash; use a period, a colon, a comma or parentheses", lines[match.index]);
  }
  for (const { text, lines } of texts(prose.read, { code: false, strong: false, urls: false, alt: false })) {
    for (const { pattern } of HISTORY) {
      for (const match of text.matchAll(pattern)) add("writing.word", `"${oneLine(match[0])}" tells a history or what is not promised; say what is true`, lines[match.index]);
    }
    for (const match of text.matchAll(USED_TO)) {
      if (!afterBe(text, match.index)) add("writing.word", `"${oneLine(match[0])}" tells a history; say what is true`, lines[match.index]);
    }
    if (section !== "contribute") {
      for (const match of text.matchAll(RECORD_TERMS)) add("writing.record-term", `"${match[0]}" is a term of the development record; outside Contribute a page says what is true and how to use it`, lines[match.index]);
    }
  }

  // Outside Contribute, in prose or code: no repository path but the
  // operator's script, no check or test command, no test variable.
  if (section !== "contribute") {
    for (const { text, lines } of texts(prose.read, { code: true, strong: true })) {
      for (const found of namedProblems(text, (index) => lines[index])) add(found.rule, found.message, found.line);
    }
    for (const { text, line } of codeLines(prose.read)) {
      for (const found of namedProblems(text, () => line)) add(found.rule, found.message, found.line);
    }
  }

  // The first paragraph opens with what the page is about, never with the
  // page itself.
  const opening = prose.units.find((unit) => unit.kind === "paragraph" && unit.words > 0);
  if (opening) {
    const start = flatten(opening.node, prose.read, { code: true, strong: true }).text.replace(new RegExp(GAP, "g"), "").trimStart();
    const self = /^this\s+(?:page|guide|section)(?![\p{L}\p{N}])/iu.exec(start);
    if (self) add("writing.opening", `the first paragraph opens with "${self[0]}"; open with what the reader does or sees`, opening.line);
  }

  // What a read_when line names, the body names.
  for (const found of readWhenProblems({ text, page, names })) add(found.rule, found.message, found.line);

  // Something to do or see before word 151: a page with fewer words has
  // no word 151 to pass.
  if (FIRST_SCREEN_SECTIONS.includes(section)) {
    const first = Math.min(...prose.shown.map((shown) => shown.key));
    const before = prose.words.filter((word) => word.key < first);
    if (before.length > LIMITS.firstScreen) {
      add("writing.first-screen", `word ${LIMITS.firstScreen + 1} of the prose comes before any code block, picture, recording, table or numbered step; open with something to do or see`, before[LIMITS.firstScreen].line);
    }
  }

  return problems.sort(byPlace);
}

/** Every writing problem in the tree: the list's own entries, then each
 * authored page off the list. `names` are those `writingNames` gives.
 * Returns the problems, the pages the rules read and the pages the list
 * kept out. */
export function checkWriting({ files, read, names = writingNames() }) {
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
    problems.push(...checkPageWriting({ file, text, page, names }));
  }
  return { problems: problems.sort(byPlace), checked, listed: pages.filter((file) => listed.has(file)) };
}
