import type { TemplateFacts } from "./format";

/**
 * NOTICE's section for the shipped templates, held both ways against the
 * shipped set: every shipped version is listed with every source its data
 * comes from, the source's licence and its credit text, and nothing is
 * listed that does not ship. With nothing shipped the section says so in
 * one line.
 *
 * The section's lines, under its heading:
 *
 *     - <id> version <n> ("<title>"):
 *       - <source name>, <licence>: <credit text>
 */

export const NOTICE_SECTION_HEADING = "Shipped templates";
export const NOTICE_NONE_LINE = "No template ships in this release.";

const ENTRY = /^- ([a-z0-9-]+) version (\d+) \("(.*)"\):$/;
const SOURCE = /^ {2}- (.+), ([A-Za-z0-9][A-Za-z0-9.+-]*): (.+)$/;

interface NoticeEntry {
  id: string;
  version: number;
  title: string;
  sources: { name: string; licence: string; credit: string }[];
}

/** The section's lines, from its heading's underline to the next heading. */
function sectionLines(notice: string): string[] | null {
  const lines = notice.split("\n");
  const start = lines.findIndex((line, i) => line === NOTICE_SECTION_HEADING && /^-+$/.test(lines[i + 1] ?? ""));
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 2; i < lines.length; i++) {
    // The next heading: a line underlined with dashes.
    if (/^-{3,}$/.test(lines[i + 1] ?? "") && lines[i].trim() !== "") break;
    body.push(lines[i]);
  }
  return body;
}

/** Every way the section and the shipped set disagree, or none. */
export function noticeProblems(notice: string, shipped: readonly TemplateFacts[]): string[] {
  const lines = sectionLines(notice);
  if (lines === null) return [`NOTICE has no "${NOTICE_SECTION_HEADING}" section.`];
  const problems: string[] = [];
  const entries: NoticeEntry[] = [];
  let saysNone = false;
  for (const line of lines) {
    if (line === NOTICE_NONE_LINE) { saysNone = true; continue; }
    const entry = ENTRY.exec(line);
    if (entry) {
      entries.push({ id: entry[1], version: Number(entry[2]), title: entry[3], sources: [] });
      continue;
    }
    const source = SOURCE.exec(line);
    if (source && entries.length > 0) {
      entries[entries.length - 1].sources.push({ name: source[1], licence: source[2], credit: source[3] });
      continue;
    }
    if (/^ *- /.test(line)) problems.push(`NOTICE's shipped templates section has a line it cannot read: "${line}".`);
  }
  if (shipped.length === 0 && !saysNone) problems.push(`NOTICE's shipped templates section must say "${NOTICE_NONE_LINE}" while none ships.`);
  if (shipped.length > 0 && saysNone) problems.push(`NOTICE's shipped templates section says none ships, and ${shipped.length} do.`);
  for (const facts of shipped) {
    const entry = entries.find((e) => e.id === facts.id && e.version === facts.version);
    if (!entry) {
      problems.push(`NOTICE does not list the shipped template ${facts.id} version ${facts.version}.`);
      continue;
    }
    if (entry.title !== facts.title) problems.push(`NOTICE titles ${facts.id} version ${facts.version} "${entry.title}"; it is "${facts.title}".`);
    const want = facts.sources.map((s) => `${s.name}, ${s.licence}: ${s.credit}`);
    const have = entry.sources.map((s) => `${s.name}, ${s.licence}: ${s.credit}`);
    if (want.join("\n") !== have.join("\n")) {
      problems.push(`NOTICE's sources for ${facts.id} version ${facts.version} are not its sources with their licences and credits.`);
    }
  }
  for (const entry of entries) {
    if (!shipped.some((f) => f.id === entry.id && f.version === entry.version)) {
      problems.push(`NOTICE lists ${entry.id} version ${entry.version}, which does not ship.`);
    }
  }
  return problems;
}
