// The documentation's page contract: what a page under docs/ must carry and
// where it may live, held by `npm run lint:docs`.
//
// The documentation site builds from the same tree and applies the same
// rules to the same parsed values, so a page valid here is valid there. The
// shared cases in test-support/docs-contract/cases.json are run through this
// module by the unit suite and through the site's build by its own seeds;
// they are how the two sides are shown to agree rather than assumed to.
//
// Each problem names the file, the rule and, where it has one, the line.
// The rule names are stable: the cases and the site's seeds refer to them.

import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { DOCS_SITE_URL } from "../src/lib/docs-site.ts";

const posix = path.posix;

/** The six sections, in their fixed order, with the one-line descriptions
 * the index, the site and llms.txt all use. */
export const SECTION_INFO = [
  { id: "start", title: "Start", description: "What Dezfil is and your first map." },
  { id: "guides", title: "Guides", description: "How to do each thing in the app." },
  { id: "reference", title: "Reference", description: "The exact rules: the API, MCP, configuration, limits, formats, shortcuts." },
  { id: "operate", title: "Operate", description: "Running an instance." },
  { id: "develop", title: "Develop", description: "Changing the code." },
  { id: "about", title: "About", description: "Licence, credits, changes and policies." },
];
export const SECTIONS = SECTION_INFO.map((section) => section.id);

/** The four root files the site renders as documentation, at fixed
 * addresses, with fixed summaries. They carry no frontmatter. */
export const IMPORTED = [
  { file: "CHANGELOG.md", page: "about/changelog", summary: "What changed in each release." },
  { file: "SECURITY.md", page: "about/security-policy", summary: "Which versions get fixes and how to report a vulnerability." },
  { file: "CONTRIBUTING.md", page: "develop/contributing", summary: "How to get a change from your machine into the project." },
  { file: "CODE_OF_CONDUCT.md", page: "develop/code-of-conduct", summary: "The standards for taking part and how they are enforced." },
];

/** The site's operation reference, generated from the API description. */
export const GENERATED_REFERENCE = "reference/api";

export const AUDIENCES = ["user", "operator", "developer", "agent"];
export const SUMMARY_LIMIT = 160;
export const READ_WHEN_LIMIT = 5;
const REQUIRED = ["title", "summary", "read_when", "audience", "checked"];
const FIELDS = new Set([...REQUIRED, "checked_on", "order", "moved_from"]);
const NAME = /^[a-z0-9-]+$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

const problem = (file, rule, message, line) => ({ file, rule, message, ...(line ? { line } : {}) });

/** Today as YYYY-MM-DD in UTC, the reference for "not in the future". */
export const today = () => new Date().toISOString().slice(0, 10);

/** A page's address below the docs home, such as `reference/http-api`, or
 * null when the path is not a page's. */
export function pageAddress(file) {
  const match = /^docs\/(.+)\.md$/.exec(file);
  if (!match || file === "docs/README.md") return null;
  return match[1];
}

/** Where a file under docs/ belongs: a page, one of the generated files,
 * a picture or recording, or nowhere. */
export function placeOf(file) {
  const parts = file.split("/");
  if (parts[0] !== "docs") return { kind: "outside" };
  if (file === "docs/README.md") return { kind: "index" };
  if (file === "docs/reference/openapi.json") return { kind: "description" };
  if (file === "docs/images/manifest.json") return { kind: "manifest" };
  if (parts[1] === "images") {
    const media = parts.length === 4 && SECTIONS.includes(parts[2]) && /^[a-z0-9-]+\.(webp|webm)$/.exec(parts[3]);
    return media ? { kind: media[1] === "webp" ? "picture" : "recording", name: parts[3] } : { kind: "misplaced" };
  }
  const page = (parts.length === 3 || parts.length === 4) && SECTIONS.includes(parts[1]) && file.endsWith(".md");
  if (!page) return { kind: "misplaced" };
  const names = [...parts.slice(2, -1), parts.at(-1).slice(0, -3)];
  return { kind: "page", section: parts[1], names };
}

// ---------------------------------------------------------------------------
// Frontmatter

/** Split a page into its frontmatter and body, parsing the frontmatter with
 * the YAML parser the site's loader uses. */
export function splitPage(text) {
  const lines = text.split("\n");
  if (lines[0].replace(/\r$/, "") !== "---") return { error: "the page does not begin with a frontmatter block", body: text, bodyLine: 1 };
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1) return { error: "the frontmatter block is never closed", body: text, bodyLine: 1 };
  let data;
  try {
    data = load(lines.slice(1, end).join("\n"));
  } catch (error) {
    return { error: `the frontmatter is not valid YAML: ${String(error.message).split("\n")[0]}`, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    return { error: "the frontmatter is not a set of fields", body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
  }
  return { data, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
}

const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/** A date field's parsed value as YYYY-MM-DD, or null. An unquoted date is
 * a YAML timestamp; it is the same date when it carries no time of day. */
export function dateValue(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : null;
  }
  if (typeof value !== "string") return null;
  const match = DATE.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

/** The frontmatter's rules over its parsed values, never its spelling, so a
 * flow list or a folded string is as valid as a block one. */
export function checkFrontmatter(data, { file = "", on = today() } = {}) {
  const problems = [];
  const add = (rule, message) => problems.push(problem(file, rule, message));
  for (const field of REQUIRED) if (!(field in data)) add("frontmatter.missing-field", `the required field ${field} is missing`);
  for (const field of Object.keys(data)) if (!FIELDS.has(field)) add("frontmatter.unknown-field", `the field ${field} is not part of the page contract`);
  if ("title" in data && !nonEmptyString(data.title)) add("frontmatter.title", "title must be a non-empty string");
  if ("summary" in data) {
    if (!nonEmptyString(data.summary)) add("frontmatter.summary", "summary must be a non-empty string");
    else if ([...data.summary].length > SUMMARY_LIMIT) add("frontmatter.summary-length", `summary is ${[...data.summary].length} characters, over ${SUMMARY_LIMIT}`);
  }
  if ("read_when" in data) {
    const list = data.read_when;
    if (!Array.isArray(list) || !list.every(nonEmptyString)) add("frontmatter.read-when", "read_when must be a list of non-empty strings");
    else if (list.length < 1 || list.length > READ_WHEN_LIMIT) add("frontmatter.read-when-count", `read_when has ${list.length} lines; it takes one to ${READ_WHEN_LIMIT}`);
  }
  if ("audience" in data) {
    const list = data.audience;
    if (!Array.isArray(list) || list.length === 0 || !list.every((value) => AUDIENCES.includes(value))) {
      add("frontmatter.audience", `audience must be a list of one or more of ${AUDIENCES.join(", ")}`);
    }
  }
  const versioned = typeof data.checked === "string" && VERSION.test(data.checked);
  if ("checked" in data && !versioned && data.checked !== "none") add("frontmatter.checked", "checked must be a version of three numbers or none");
  if ("checked_on" in data) {
    if (!versioned) {
      if (data.checked === "none") add("frontmatter.checked-on-without-version", "checked_on is present while checked is none");
    } else {
      const date = dateValue(data.checked_on);
      if (!date) add("frontmatter.date-form", "checked_on must be a date written YYYY-MM-DD");
      else if (date > on) add("frontmatter.date-future", `checked_on ${date} is in the future`);
    }
  } else if (versioned) add("frontmatter.checked-on-missing", "checked names a version, so checked_on must give the date");
  if ("order" in data && !Number.isInteger(data.order)) add("frontmatter.order", "order must be a whole number");
  if ("moved_from" in data && (!Array.isArray(data.moved_from) || data.moved_from.length === 0 || !data.moved_from.every((value) => typeof value === "string"))) {
    add("moved-from.form", "moved_from must be a list of site addresses");
  }
  return problems;
}

/** The parsed values the site reads, in the form both sides compare. */
export function frontmatterValues(data) {
  const values = {
    title: data.title,
    summary: data.summary,
    read_when: data.read_when,
    audience: data.audience,
    checked: data.checked,
  };
  if ("checked_on" in data) values.checked_on = dateValue(data.checked_on);
  if ("order" in data) values.order = data.order;
  if ("moved_from" in data) values.moved_from = data.moved_from;
  return values;
}

// ---------------------------------------------------------------------------
// Body: headings and their anchors

/** The body's lines with fenced code blanked, so nothing inside a code
 * block reads as a heading or a link. Line count is kept. */
export function withoutFences(body) {
  let fence = null;
  return body.split("\n").map((line) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return "";
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) { fence = marker[1]; return ""; }
    return line;
  });
}

/** As above, with inline code blanked too, keeping its width so offsets
 * still map to lines. */
export function withoutCode(body) {
  return withoutFences(body).map((line) => line.replace(/(`+)(.+?)\1/g, (match) => " ".repeat(match.length)));
}

/** The text a heading renders to, as the anchor is made from it. */
export function headingText(markdown) {
  const parts = markdown.split(/(`+)(.*?)\1/);
  let text = "";
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 3 === 2) { text += parts[i]; continue; }
    if (i % 3 === 1) continue;
    text += parts[i]
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\\(.)/g, "$1")
      .replace(/\*+|~~/g, "")
      .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1");
  }
  return text.trim();
}

/** Anchors as GitHub and the site's renderer make them: lower case, marks
 * and punctuation other than hyphens and underscores dropped, spaces to
 * hyphens, a repeated anchor numbered from 1. */
export function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
    let slug = base;
    while (seen.has(slug)) {
      seen.set(base, seen.get(base) + 1);
      slug = `${base}-${seen.get(base)}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

/** The body's headings, with their level, text, anchor and line. */
export function headings(body, firstLine = 1) {
  const lines = withoutFences(body);
  const slug = slugger();
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(lines[i]);
    let level = 0, text = "";
    if (atx) { level = atx[1].length; text = atx[2] ?? ""; }
    else if (i > 0 && lines[i - 1].trim() !== "" && !/^ {0,3}(#|[-*+] |\d+[.)] |>|\|)/.test(lines[i - 1])) {
      if (/^ {0,3}=+\s*$/.test(lines[i])) { level = 1; text = lines[i - 1]; }
      else if (/^ {0,3}-+\s*$/.test(lines[i])) { level = 2; text = lines[i - 1]; }
    }
    if (!level) continue;
    const plain = headingText(text);
    found.push({ level, text: plain, anchor: slug(plain), line: firstLine + (atx ? i : i - 1) });
  }
  return found;
}

/** Heading rules: no first-level heading, the first at level two, and no
 * level skipped on the way down. */
export function checkHeadings(file, list) {
  const problems = [];
  let previous = 1;
  for (const heading of list) {
    if (heading.level === 1) problems.push(problem(file, "body.first-level-heading", `"${heading.text}" is a first-level heading; the title lives in the frontmatter`, heading.line));
    else if (heading.level > previous + 1) problems.push(problem(file, "body.skipped-heading-level", `"${heading.text}" is level ${heading.level} after level ${previous}`, heading.line));
    previous = heading.level;
  }
  return problems;
}

/** Check one page's text on its own: the frontmatter and the headings. */
export function checkPageText(text, { file = "", on = today() } = {}) {
  const page = splitPage(text);
  if (page.error) return { problems: [problem(file, "frontmatter.missing", page.error, 1)], page };
  const problems = [...checkFrontmatter(page.data, { file, on }), ...checkHeadings(file, headings(page.body, page.bodyLine))];
  return { problems, page };
}

// ---------------------------------------------------------------------------
// Links and pictures

/** Every link and picture in a body, with its line. Code is ignored. */
export function references(body, firstLine = 1) {
  const text = withoutCode(body).join("\n");
  const lineAt = (index) => firstLine + text.slice(0, index).split("\n").length - 1;
  const found = [];
  const target = String.raw`(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)`;
  const definitions = new Map();
  for (const match of text.matchAll(/^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*(<[^>\n]*>|\S+)/gm)) {
    definitions.set(match[1].trim().toLowerCase(), match[2]);
    found.push({ type: "link", target: match[2], line: lineAt(match.index) });
  }
  let rest = text.replace(new RegExp(String.raw`!\[([^\]]*)\]\(\s*${target}`, "g"), (match, alt, src, offset) => {
    found.push({ type: "image", target: src, alt, line: lineAt(offset) });
    return " ".repeat(match.length);
  });
  rest = rest.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (match, alt, label, offset) => {
    const src = definitions.get((label || alt).trim().toLowerCase());
    found.push({ type: "image", target: src ?? "", alt, line: lineAt(offset) });
    return " ".repeat(match.length);
  });
  for (const match of rest.matchAll(new RegExp(String.raw`\[(?:[^\]]*)\]\(\s*${target}`, "g"))) {
    found.push({ type: "link", target: match[1], line: lineAt(match.index) });
  }
  for (const match of rest.matchAll(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    found.push({ type: "link", target: match[1] ?? match[2], line: lineAt(match.index) });
  }
  for (const match of rest.matchAll(/<img\s[^>]*>/gi)) {
    const attribute = (name) => new RegExp(String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(match[0]);
    const src = attribute("src"), alt = attribute("alt");
    found.push({ type: "image", target: src ? (src[1] ?? src[2]) : "", alt: alt ? (alt[1] ?? alt[2]) : "", line: lineAt(match.index) });
  }
  return found.map((entry) => ({ ...entry, target: entry.target.replace(/^<(.*)>$/, "$1") }));
}

/** Whether a repository path is where a generated page lives: the docs home,
 * a section page or the operation reference. */
function generatedLocation(resolved) {
  const address = resolved.replace(/\/+$/, "");
  if (address === "docs") return true;
  if (SECTIONS.some((section) => address === `docs/${section}`)) return true;
  return address === `docs/${GENERATED_REFERENCE}` || address.startsWith(`docs/${GENERATED_REFERENCE}/`);
}

const decode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };

// ---------------------------------------------------------------------------
// The tree

/** Every problem in the documentation tree.
 *
 * `files` lists the repository's files as POSIX paths from its root; `read`
 * returns a file's text. The lint passes the files git knows; the tests pass
 * a fixture tree. */
export function checkTree({ files, read, on = today() }) {
  const problems = [];
  const fileSet = new Set(files);
  const folders = new Set(files.flatMap((file) => file.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const pages = [];

  // Where each file under docs/ belongs.
  const sectionPages = new Map();
  for (const file of files.filter((f) => f.startsWith("docs/")).sort()) {
    const place = placeOf(file);
    if (place.kind === "misplaced") { problems.push(problem(file, "tree.out-of-place", "nothing of this kind belongs here under docs/")); continue; }
    if (place.kind !== "page") continue;
    const section = file.split("/")[1];
    sectionPages.set(section, (sectionPages.get(section) ?? 0) + 1);
    const bad = place.names.find((name) => !NAME.test(name));
    if (bad !== undefined) problems.push(problem(file, "tree.file-name", `"${bad}" is not lowercase letters, digits and hyphens`));
    pages.push(file);
  }
  for (const section of SECTIONS) {
    if (folders.has(`docs/${section}`) && !sectionPages.has(section)) {
      problems.push(problem(`docs/${section}`, "tree.empty-section", "a section folder exists only while it holds a page"));
    }
  }

  // The addresses that are served whatever the pages say.
  const imported = new Map(IMPORTED.map((entry) => [entry.page, entry.file]));
  const live = new Map([["/docs/", "the docs home"], ...SECTIONS.map((s) => [`/docs/${s}/`, `the ${s} section page`])]);
  const raw = new Map();
  for (const entry of IMPORTED) {
    live.set(`/docs/${entry.page}/`, entry.file);
    raw.set(`/docs/${entry.page}.md`, entry.file);
  }

  // Address ownership.
  for (const file of pages) {
    const address = pageAddress(file);
    const folder = posix.dirname(address);
    for (const [page, owner] of imported) {
      if (address === page || folder === page || folder.startsWith(`${page}/`)) {
        problems.push(problem(file, "address.imported-document", `/docs/${page}/ belongs to ${owner}`));
      }
    }
    if (address === GENERATED_REFERENCE || address.startsWith(`${GENERATED_REFERENCE}/`)) {
      problems.push(problem(file, "address.generated-reference", `/docs/${GENERATED_REFERENCE}/ and everything under it belong to the generated operation reference`));
    }
    live.set(`/docs/${address}/`, file);
    raw.set(`/docs/${address}.md`, file);
  }

  // Each page's own text.
  const parsed = new Map();
  const anchorsOf = new Map();
  const anchors = (file) => {
    if (!anchorsOf.has(file)) {
      let text = "";
      try { text = read(file); } catch { /* reported as a dead link */ }
      const page = file.startsWith("docs/") ? splitPage(text) : { body: text, bodyLine: 1 };
      anchorsOf.set(file, new Set(headings(page.body ?? text, page.bodyLine).map((h) => h.anchor)));
    }
    return anchorsOf.get(file);
  };
  for (const file of pages) {
    const { problems: own, page } = checkPageText(read(file), { file, on });
    problems.push(...own);
    if (!page.error) parsed.set(file, page);
  }

  // The manifest's rows, by file under docs/images/.
  let listed = new Set();
  if (fileSet.has("docs/images/manifest.json")) {
    try {
      const manifest = JSON.parse(read("docs/images/manifest.json"));
      listed = new Set((manifest.rows ?? []).map((row) => row.file));
    } catch (error) {
      problems.push(problem("docs/images/manifest.json", "manifest.unreadable", `the manifest is not readable JSON: ${error.message}`));
    }
  }

  const importedFiles = new Set(IMPORTED.map((entry) => entry.file));
  const isDocument = (file) => pages.includes(file) || importedFiles.has(file);

  for (const [file, page] of parsed) {
    const own = anchors(file);
    for (const ref of references(page.body, page.bodyLine)) {
      const where = (rule, message) => problems.push(problem(file, rule, message, ref.line));
      const target = ref.target.trim();
      const external = /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
      if (ref.type === "image") {
        if (!target || external || target.startsWith("/")) { where("image.outside-images", `${target || "an empty source"} is not a file under docs/images/`); continue; }
        const resolved = posix.normalize(posix.join(posix.dirname(file), decode(target.split(/[?#]/)[0])));
        if (!resolved.startsWith("docs/images/")) where("image.outside-images", `${target} is not under docs/images/`);
        else if (!fileSet.has(resolved)) where("image.missing", `${target} does not exist`);
        else if (!listed.has(resolved.slice("docs/images/".length))) where("image.not-in-manifest", `${target} has no row in docs/images/manifest.json`);
        if (!ref.alt || !ref.alt.trim()) where("image.no-alt", `${target} has no alternative text`);
        continue;
      }
      if (!target) { where("link.dead-file", "the link has no target"); continue; }
      if (target.startsWith("#")) {
        if (!own.has(decode(target.slice(1)))) where("link.dead-page", `this page has no heading ${target}`);
        continue;
      }
      // The third and fourth kinds: a generated page by its full site
      // address is accepted by its prefix; anything else absolute is
      // external and kept as written.
      if (external) continue;
      const hash = target.indexOf("#");
      const pathPart = decode((hash === -1 ? target : target.slice(0, hash)).split("?")[0]);
      const fragment = hash === -1 ? "" : decode(target.slice(hash + 1));
      if (pathPart.startsWith("/")) {
        if (pathPart === "/docs" || pathPart.startsWith("/docs/")) where("link.generated-not-full", `${target} is a site address; a generated page is linked by ${DOCS_SITE_URL}..., a page by its relative path`);
        else where("link.not-relative", `${target} is not relative to this page`);
        continue;
      }
      const resolved = posix.normalize(posix.join(posix.dirname(file), pathPart)).replace(/\/+$/, "");
      if (resolved === ".." || resolved.startsWith("../")) { where("link.dead-file", `${target} leaves the repository`); continue; }
      if (generatedLocation(resolved) && !fileSet.has(resolved)) {
        where("link.generated-not-full", `${target} points at a generated page; link it by its full site address under ${DOCS_SITE_URL}`);
        continue;
      }
      if (fileSet.has(resolved)) {
        if (fragment && isDocument(resolved) && !anchors(resolved).has(fragment)) where("link.dead-page", `${resolved} has no heading #${fragment}`);
        continue;
      }
      if (folders.has(resolved) || resolved === ".") continue;
      where(resolved.endsWith(".md") ? "link.dead-page" : "link.dead-file", `${target} resolves to ${resolved}, which does not exist`);
    }
  }

  // Old addresses: each under /docs/, listed once, owned by nothing else.
  const movedBy = new Map();
  for (const [file, page] of parsed) {
    const list = Array.isArray(page.data.moved_from) ? page.data.moved_from : [];
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      if (!/^\/docs\/[^\s?#]+$/.test(entry) || entry.includes("//")) {
        problems.push(problem(file, "moved-from.form", `${entry} is not a site address under /docs/ without a query or fragment`));
        continue;
      }
      const address = entry.endsWith("/") || entry.endsWith(".md") ? entry : `${entry}/`;
      if (live.has(address)) problems.push(problem(file, "moved-from.live-page", `${entry} is served by ${live.get(address)}`));
      else if (raw.has(address)) problems.push(problem(file, "moved-from.raw-markdown", `${entry} is the raw markdown of ${raw.get(address)}`));
      else if (address.startsWith(`/docs/${GENERATED_REFERENCE}/`)) problems.push(problem(file, "moved-from.live-page", `${entry} is under the generated operation reference`));
      if (movedBy.has(address)) problems.push(problem(file, "moved-from.duplicate", `${entry} is also listed by ${movedBy.get(address)}`));
      else movedBy.set(address, file);
    }
  }

  return { problems, pages };
}

/** Pages in their reading order: by `order` first (pages without one after
 * those with one), then by title, then by path. */
export function comparePages(a, b) {
  const left = Number.isInteger(a.order) ? a.order : Infinity;
  const right = Number.isInteger(b.order) ? b.order : Infinity;
  if (left !== right) return left < right ? -1 : 1;
  const byTitle = String(a.title).localeCompare(String(b.title), "en");
  if (byTitle !== 0) return byTitle;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** A section's pages in reading order: the section's own pages first, then
 * each subfolder's pages as a group, groups by folder name. Within each,
 * by `order`, title and path. */
export function indexOrder(pages) {
  const folderOf = (page) => page.path.split("/").slice(2, -1).join("/");
  const folders = [...new Set(pages.map(folderOf))].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return folders.flatMap((folder) => pages.filter((page) => folderOf(page) === folder).sort(comparePages));
}

/** The four imported documents with the title the site takes from each
 * one's first heading. */
export function importedDocuments(read) {
  return IMPORTED.map((entry) => {
    let title = entry.file;
    try { title = headingText(/^# +(.+?)\s*#*\s*$/m.exec(read(entry.file))?.[1] ?? entry.file); } catch { /* named by file */ }
    return { ...entry, title, section: entry.page.split("/")[0] };
  });
}

const titleOf = (id) => SECTION_INFO.find((section) => section.id === id).title;
const folderTitle = (name) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");

/** The agents' index, docs/README.md, generated from the pages'
 * frontmatter: the six sections in order, one entry per page with its
 * title, path, summary, read_when lines, audience and checked, then the
 * documents and generated files that sit beside the pages. */
export function generateIndex({ files, read }) {
  const fileSet = new Set(files);
  const pages = [];
  for (const file of files) {
    if (placeOf(file).kind !== "page") continue;
    const page = splitPage(read(file));
    if (page.error) continue;
    pages.push({ path: file, ...page.data });
  }
  const lines = [
    "# Dezfil documentation",
    "",
    "Every page under `docs/`, generated from the pages' own frontmatter. Find the",
    "section for what you are doing, then the page whose \"read when\" line is",
    "your situation. `checked` is the release a page was last read against a",
    "running instance of, with the date, or `none` until it has been. The same",
    `pages are published at ${DOCS_SITE_URL}.`,
    "",
    "This file is written by `npm run docs:write` and held by `npm run lint:docs`:",
    "change the pages, then regenerate it.",
  ];
  const list = (value) => (Array.isArray(value) ? value.join("; ") : String(value));
  for (const section of SECTION_INFO) {
    lines.push("", `## ${section.title}`, "", section.description);
    let folder = null;
    for (const page of indexOrder(pages.filter((p) => p.path.split("/")[1] === section.id))) {
      const group = page.path.split("/").slice(2, -1).join("/");
      if (group && group !== folder) lines.push("", `### ${folderTitle(group)}`);
      folder = group;
      const checked = page.checked === "none" ? "none" : `${page.checked}, ${dateValue(page.checked_on) ?? page.checked_on}`;
      lines.push(
        "",
        `- [${page.title}](${page.path.slice("docs/".length)})`,
        `  - path: \`${page.path}\``,
        `  - summary: ${page.summary}`,
        `  - read when: ${list(page.read_when)}`,
        `  - audience: ${list(page.audience).replace(/; /g, ", ")}`,
        `  - checked: ${checked}`,
      );
    }
  }
  lines.push("", "## Also", "");
  for (const doc of importedDocuments(read)) {
    lines.push(`- [${doc.title}](../${doc.file}) (${titleOf(doc.section)}): ${doc.summary}`);
  }
  if (fileSet.has("docs/reference/openapi.json")) {
    lines.push("- [The OpenAPI description](reference/openapi.json) (Reference): the HTTP API as the server serves it, generated from the source; the operation reference is built from it.");
  }
  if (fileSet.has("docs/images/manifest.json")) {
    lines.push("- [The image manifest](images/manifest.json): one row per picture and recording, with the scene it shows, its size and when it was taken.");
  }
  return `${lines.join("\n")}\n`;
}

/** The index's freshness: the committed file equals what the pages
 * generate. */
export function checkIndex({ files, read }) {
  const expected = generateIndex({ files, read });
  let committed = null;
  try { committed = files.includes("docs/README.md") ? read("docs/README.md") : null; } catch { /* missing */ }
  if (committed === expected) return [];
  return [problem("docs/README.md", "index.stale", committed === null
    ? "the index is missing; run npm run docs:write"
    : "the index differs from what the pages generate; run npm run docs:write")];
}

/** A problem as one line: the file, the line where there is one, the rule. */
export function formatProblem(p) {
  return `${p.file}${p.line ? `:${p.line}` : ""}: ${p.rule}: ${p.message}`;
}

/** Read a file of the tree as text. */
export const reader = (root) => (file) => readFileSync(path.join(root, file), "utf8");
