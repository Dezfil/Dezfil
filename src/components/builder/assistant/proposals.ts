/**
 * SQL proposals in a reply: each completed SQL-marked fenced code block
 * in a reply is one proposal, kept exactly as the model wrote it,
 * comments and literal semicolons included; prose, other code blocks and
 * a block whose fence has not closed carry no action. Whether a proposal
 * is insertable is the turn's origin's to say (a /sql-context request),
 * never this module's. Pure.
 */

export type ReplySegment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string | null; code: string; complete: boolean };

const FENCE = /^([ \t]{0,3})(```+|~~~+)[ \t]*([^\s`~]*)[^\n]*$/;

/** Split a reply into prose and fenced code blocks. A fence that never
 * closes yields one incomplete block holding what arrived so far. */
export function segmentReply(text: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  const lines = text.split("\n");
  let prose: string[] = [];
  let open: { fence: string; lang: string | null; code: string[] } | null = null;
  const flushProse = () => {
    if (prose.length === 0) return;
    const joined = prose.join("\n");
    if (joined.trim() !== "") segments.push({ kind: "text", text: joined });
    prose = [];
  };
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (open === null) {
      if (match) {
        flushProse();
        open = { fence: match[2], lang: match[3] ? match[3].toLowerCase() : null, code: [] };
      } else {
        prose.push(line);
      }
      continue;
    }
    const closes = match && match[2][0] === open.fence[0] && match[2].length >= open.fence.length && match[3] === "";
    if (closes) {
      segments.push({ kind: "code", lang: open.lang, code: open.code.join("\n"), complete: true });
      open = null;
    } else {
      open.code.push(line);
    }
  }
  flushProse();
  if (open) segments.push({ kind: "code", lang: open.lang, code: open.code.join("\n"), complete: false });
  return segments;
}

export const isSqlBlock = (segment: ReplySegment): segment is Extract<ReplySegment, { kind: "code" }> =>
  segment.kind === "code" && segment.lang === "sql";

export interface SqlProposal {
  /** The block's position among the reply's segments: the proposal's identity within its turn. */
  index: number;
  sql: string;
}

/** The completed SQL-marked blocks of a reply, in order. */
export function sqlProposals(text: string): SqlProposal[] {
  return segmentReply(text).flatMap((segment, index) => isSqlBlock(segment) && segment.complete ? [{ index, sql: segment.code }] : []);
}
