import React from "react";
import styles from "../AssistantPanel.module.css";

/**
 * The reply's markdown: a bounded, original renderer for the subset a
 * reply uses, beside the fence segmentation `proposals.ts` already does.
 * By its spelling: one to three leading hashes and a space for a heading;
 * paired double asterisks for bold, single for italics, single backticks
 * for inline code; a leading hyphen or asterisk and a space for an
 * unordered item, a leading number with a dot or parenthesis and a space
 * for an ordered one; bracketed text followed by a parenthesised absolute
 * http or https address for a link. A backslash before a punctuation
 * character keeps it literal. Inline forms nest inside blocks; block
 * forms do not nest.
 *
 * Everything else stays literal, whole: a table row or a blockquote line
 * keeps every source character with nothing inside it parsed; an image,
 * a reference link, an unpaired delimiter and raw HTML stay the text they
 * were. Model text contributes only a link's destination, checked here
 * before any anchor exists; React escapes every text node and no raw
 * HTML sink exists in this module. An inline form is literal until its
 * closing delimiter has arrived, so a streamed prefix renders honestly.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "link"; href: string; children: InlineNode[] };

export type Block =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  /** An unsupported block construct, kept as its exact source lines. */
  | { kind: "literal"; text: string };

const HEADING = /^(#{1,3}) +(.*)$/;
const UNORDERED = /^ {0,3}[-*] +(.*)$/;
const ORDERED = /^ {0,3}\d{1,9}[.)] +(.*)$/;
/** A table row or a blockquote line: kept whole, nothing inside parsed. */
const LITERAL_BLOCK = /^ {0,3}(\||>)/;
const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** Only an absolute http or https destination becomes a link; anything
 * else (a script, data or vbscript scheme, a relative path, a bare word)
 * yields no anchor and the construct stays literal. */
export function safeLinkHref(raw: string): string | null {
  if (!/^https?:\/\/[^\s<>()]+$/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return raw;
  } catch {
    return null;
  }
}

/** The closing delimiter's index at or after `from`, or -1. Asterisks
 * are read as runs: a run of one is an italics delimiter, a run of two a
 * bold one, and a longer run closes both, the bold with its first two
 * stars where it opened inside italics (`*a **b***`) and the italics with
 * the last star where it opened inside bold (`**a *b***`). A run of the
 * other kind is a nested span's, skipped whole. */
function closing(text: string, delimiter: "*" | "**", from: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "\\") { index += 2; continue; }
    if (text[index] !== "*") { index += 1; continue; }
    let run = 1;
    while (text[index + run] === "*") run += 1;
    if (delimiter === "*") {
      if (run === 1) return index;
      if (run >= 3) return index + run - 1;
    } else {
      if (run === 2) return index;
      if (run >= 3) return index + run - 2;
    }
    index += run;
  }
  return -1;
}

/** A raw HTML tag or comment at `from`: kept whole, nothing inside parsed. */
const HTML_SPAN = /^<(?:!--[\s\S]*?--|\/?[a-zA-Z][^<>]*)>/;

const MAX_DEPTH = 4;

export function parseInline(text: string, depth = 0): InlineNode[] {
  const nodes: InlineNode[] = [];
  let literal = "";
  const flush = () => { if (literal) { nodes.push({ kind: "text", text: literal }); literal = ""; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && ASCII_PUNCTUATION.test(text[i + 1])) {
      literal += text[i + 1]; i += 2; continue;
    }
    if (ch === "<") {
      // Raw HTML is text, opaque: its contents never re-enter the parser
      // (the rule's exact-literal rule).
      const span = HTML_SPAN.exec(text.slice(i));
      if (span) { literal += span[0]; i += span[0].length; continue; }
      literal += ch; i += 1; continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) { flush(); nodes.push({ kind: "code", text: text.slice(i + 1, end) }); i = end + 1; continue; }
      literal += ch; i += 1; continue;
    }
    if (text.startsWith("**", i) && depth < MAX_DEPTH) {
      const end = closing(text, "**", i + 2);
      const inner = end > i + 2 ? text.slice(i + 2, end) : "";
      if (inner && !/^\s/.test(inner) && !/\s$/.test(inner)) { flush(); nodes.push({ kind: "strong", children: parseInline(inner, depth + 1) }); i = end + 2; continue; }
      literal += "**"; i += 2; continue;
    }
    if (ch === "*" && depth < MAX_DEPTH) {
      const end = closing(text, "*", i + 1);
      const inner = end > i + 1 ? text.slice(i + 1, end) : "";
      if (inner && !/^\s/.test(inner) && !/\s$/.test(inner) && !inner.includes("\n") && !/^\*/.test(inner)) { flush(); nodes.push({ kind: "em", children: parseInline(inner, depth + 1) }); i = end + 1; continue; }
      literal += ch; i += 1; continue;
    }
    if (ch === "!" && text[i + 1] === "[") {
      // An image in markdown's spelling: the whole construct stays as typed.
      const image = linkSpan(text, i + 1);
      if (image) { literal += text.slice(i, image.end); i = image.end; continue; }
      literal += ch; i += 1; continue;
    }
    if (ch === "[" && depth < MAX_DEPTH) {
      const span = linkSpan(text, i);
      if (span) {
        const href = safeLinkHref(span.destination);
        if (href) { flush(); nodes.push({ kind: "link", href, children: parseInline(span.label, depth + 1) }); }
        else literal += text.slice(i, span.end);
        i = span.end; continue;
      }
      const reference = referenceSpan(text, i);
      if (reference) { literal += text.slice(i, reference); i = reference; continue; }
      literal += ch; i += 1; continue;
    }
    literal += ch; i += 1;
  }
  flush();
  return nodes;
}

/** `[label](destination)` at `from`, or null while it has not closed. */
function linkSpan(text: string, from: number): { label: string; destination: string; end: number } | null {
  if (text[from] !== "[") return null;
  const close = text.indexOf("]", from + 1);
  if (close < 0 || text[close + 1] !== "(") return null;
  const end = text.indexOf(")", close + 2);
  if (end < 0) return null;
  const label = text.slice(from + 1, close);
  const destination = text.slice(close + 2, end).trim();
  if (label.includes("[") || label.includes("\n")) return null;
  return { label, destination, end: end + 1 };
}

/** `[label][ref]`, kept whole as source characters. */
function referenceSpan(text: string, from: number): number | null {
  const close = text.indexOf("]", from + 1);
  if (close < 0 || text[close + 1] !== "[") return null;
  const end = text.indexOf("]", close + 2);
  if (end < 0) return null;
  return end + 1;
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i += 1; continue; }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, children: parseInline(heading[2]) }); i += 1; continue; }
    if (LITERAL_BLOCK.test(line)) {
      const kept: string[] = [];
      while (i < lines.length && LITERAL_BLOCK.test(lines[i])) kept.push(lines[i++]);
      blocks.push({ kind: "literal", text: kept.join("\n") });
      continue;
    }
    const ordered = ORDERED.test(line);
    if (ordered || UNORDERED.test(line)) {
      const pattern = ordered ? ORDERED : UNORDERED;
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const item = pattern.exec(lines[i]);
        if (!item) break;
        items.push(parseInline(item[1]));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !HEADING.test(lines[i]) && !UNORDERED.test(lines[i]) && !ORDERED.test(lines[i]) && !LITERAL_BLOCK.test(lines[i])) para.push(lines[i++]);
    blocks.push({ kind: "paragraph", children: parseInline(para.join(" ")) });
  }
  return blocks;
}

function renderInline(nodes: InlineNode[]): React.ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text": return node.text;
      case "code": return <code key={index}>{node.text}</code>;
      case "strong": return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em": return <em key={index}>{renderInline(node.children)}</em>;
      case "link": return <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">{renderInline(node.children)}</a>;
    }
  });
}

/** The prose of a reply as elements. With `caret`, the reference's
 * streaming caret sits inline at the end of the last block. */
export function ReplyProse({ text, caret = false }: { text: string; caret?: boolean }) {
  const blocks = parseBlocks(text);
  const mark = caret ? <span className={styles.caret} data-caret aria-hidden /> : null;
  return (
    <>
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1 ? mark : null;
        switch (block.kind) {
          case "heading": return <h4 key={index} data-level={block.level}>{renderInline(block.children)}{last}</h4>;
          case "paragraph": return <p key={index}>{renderInline(block.children)}{last}</p>;
          case "literal": return <p key={index} className={styles.literal} data-literal>{block.text}{last}</p>;
          case "list": {
            const items = block.items.map((item, at) => <li key={at}>{renderInline(item)}{at === block.items.length - 1 ? last : null}</li>);
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
        }
      })}
      {blocks.length === 0 ? mark : null}
    </>
  );
}
