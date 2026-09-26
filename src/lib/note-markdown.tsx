import { Fragment, type ReactNode } from "react";

/**
 * The note's formatting subset, rendered straight to React elements:
 * paragraphs, "- " lists, **bold**, *italic*, and [text](url) links. Safe by
 * construction — nothing here parses or injects HTML, so raw markup in the
 * text arrives as inert text without a sanitizer. Links render only for
 * http(s) targets (anything else stays literal text) and always open in a
 * new tab.
 *
 * The workflow canvas's notes ask, by option, for two more things the map
 * widget does not: three levels of heading and inline `code`. Without the
 * option the rendering is exactly the widget's.
 */

export interface NoteMarkdownOptions {
  /** `#`, `##` and `###` lines as headings. */
  headings?: boolean;
  /** `` `code` `` inline. */
  code?: boolean;
  /** Image syntax (`![alt](url)`) stays text whole, its link part too. */
  inertImages?: boolean;
}

const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
const INLINE_WITH_CODE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderInline(text: string, keyBase: string, code: boolean, inertImages = false): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  const pattern = code ? INLINE_WITH_CODE : INLINE;
  // With code on, every group shifts by one behind the code group.
  const at = (m: RegExpMatchArray, group: number) => m[code ? group + 1 : group];
  for (const m of text.matchAll(pattern)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    if (code && m[1] !== undefined) {
      out.push(<code key={`${keyBase}-c${i}`}>{m[1]}</code>);
    } else if (inertImages && at(m, 3) !== undefined && index > 0 && text[index - 1] === "!") {
      // Image syntax: the link part stays text with its bang.
      out.push(m[0]);
    } else if (at(m, 1) !== undefined) {
      out.push(<strong key={`${keyBase}-b${i}`}>{at(m, 1)}</strong>);
    } else if (at(m, 2) !== undefined) {
      out.push(<em key={`${keyBase}-i${i}`}>{at(m, 2)}</em>);
    } else if (/^https?:\/\//i.test(at(m, 4) ?? "")) {
      out.push(
        <a
          key={`${keyBase}-a${i}`}
          href={at(m, 4)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {at(m, 3)}
        </a>,
      );
    } else {
      // Non-http(s) target (javascript:, data:, …): the whole thing stays text.
      out.push(m[0]);
    }
    last = index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING = /^(#{1,3})\s+(.*)$/;

/** Blocks split on blank lines. Inside a block a dash line starts a list
 * wherever it stands: the lines fall into runs of "- " lines, each a
 * list, and runs of other lines, each a paragraph. With headings on, a
 * line opening with one to three `#` is a heading of that level, and the
 * lines between headings are read the same way. */
export function renderNoteBody(body: string, options: NoteMarkdownOptions = {}): ReactNode[] {
  const code = options.code === true;
  const headings = options.headings === true;
  const inertImages = options.inertImages === true;
  const blocks = body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b !== "");
  const renderLines = (lines: string[], key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    let run: string[] = [];
    let listing = false;
    let ri = 0;
    const flush = () => {
      if (!run.length) return;
      const k = `${key}-${ri++}`;
      out.push(
        listing ? (
          <ul key={k}>
            {run.map((l, li) => (
              <li key={li}>{renderInline(l.trim().slice(2), `${k}-${li}`, code, inertImages)}</li>
            ))}
          </ul>
        ) : (
          <p key={k}>
            {run.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(l, `${k}-${li}`, code, inertImages)}
              </Fragment>
            ))}
          </p>
        ),
      );
      run = [];
    };
    for (const l of lines) {
      const dash = l.trim().startsWith("- ");
      if (dash !== listing) {
        flush();
        listing = dash;
      }
      run.push(l);
    }
    flush();
    return out;
  };
  return blocks.map((block, bi) => {
    const lines = block.split("\n");
    if (!headings || !lines.some((l) => HEADING.test(l))) return renderLines(lines, String(bi));
    // Headings stand alone; the runs of other lines between them are blocks.
    const out: ReactNode[] = [];
    let run: string[] = [];
    let ri = 0;
    const flush = () => {
      if (!run.length) return;
      const lines = run;
      run = [];
      out.push(renderLines(lines, `${bi}-p${ri++}`));
    };
    lines.forEach((l, li) => {
      const h = HEADING.exec(l);
      if (!h) {
        run.push(l);
        return;
      }
      flush();
      const level = h[1].length;
      const inner = renderInline(h[2], `${bi}-h${li}`, code, inertImages);
      out.push(level === 1 ? <h1 key={`${bi}-h${li}`}>{inner}</h1> : level === 2 ? <h2 key={`${bi}-h${li}`}>{inner}</h2> : <h3 key={`${bi}-h${li}`}>{inner}</h3>);
    });
    flush();
    return <Fragment key={bi}>{out}</Fragment>;
  });
}
