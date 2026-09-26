import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReplyProse } from "./reply-markdown";

/**
 * The rendering boundary's corpus (with 1b's unsafe links): each payload
 * reaches the renderer, displays as its exact literal text, and produces
 * none of the forbidden elements or attributes. The request half is the
 * browser's (e2e/assistant-turn.spec.ts, "1c"), since a static render issues
 * nothing. The two seeds the record names, bypassed text escaping and
 * bypassed URL rejection, were applied to the renderer itself and seen to
 * fail these cases (verification 1c).
 */
const FORBIDDEN_ELEMENT = /^<(script|img|iframe|object|embed|svg|style|link|meta|base|form|input|video|audio|source)\b/i;
const FORBIDDEN_ATTRIBUTE = /\s(on[a-z]+|src|srcdoc|style|formaction)=/i;
/** The real tags of the markup: escaped text never holds a "<", so a tag
 * found here is an element the renderer made. */
const tags = (markup: string) => markup.match(/<[a-z][^>]*>/gi) ?? [];

export const CORPUS: { name: string; payload: string }[] = [
  { name: "script markup", payload: "Done. <script>window.__pwned = 1</script> That was all." },
  { name: "an event-handler attribute", payload: 'Hover <b onmouseover="window.__pwned = 2">here</b> please.' },
  { name: "a markdown image", payload: "The map: ![parks](http://127.0.0.1:3303/corpus/markdown-image.png) shows it." },
  { name: "a raw image element", payload: 'Look: <img src="http://127.0.0.1:3303/corpus/raw-image.png" alt="x"> there.' },
  { name: "an embedded frame", payload: '<iframe src="http://127.0.0.1:3303/corpus/frame.html"></iframe> framed.' },
];
export const UNSAFE_LINKS: { name: string; payload: string }[] = [
  { name: "javascript", payload: "Open [the map](javascript:window.__pwned=3) now." },
  { name: "data", payload: "Open [the map](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) now." },
  { name: "vbscript", payload: "Open [the map](vbscript:MsgBox(1)) now." },
];

const decode = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("the payload corpus displays literally and produces no forbidden node or attribute", () => {
  it.each(CORPUS)("$name", ({ payload }) => {
    const markup = renderToStaticMarkup(<ReplyProse text={payload} />);
    expect(decode(markup), "the exact literal text is shown").toBe(payload);
    expect(tags(markup).filter((tag) => FORBIDDEN_ELEMENT.test(tag)), "no forbidden element").toEqual([]);
    expect(tags(markup).filter((tag) => FORBIDDEN_ATTRIBUTE.test(tag)), "no forbidden attribute").toEqual([]);
    expect(markup).not.toContain("<a");
  });
});

describe("an unsafe destination yields no anchor and the construct stays literal", () => {
  it.each(UNSAFE_LINKS)("$name", ({ payload }) => {
    const markup = renderToStaticMarkup(<ReplyProse text={payload} />);
    expect(markup, "no anchor").not.toContain("<a");
    expect(markup).not.toContain("href");
    expect(decode(markup)).toBe(payload);
  });
});
