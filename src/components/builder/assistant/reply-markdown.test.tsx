import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReplyProse, parseInline, safeLinkHref } from "./reply-markdown";

/**
 * The reply's markdown subset (the streamed prefixes of 1f). Every expectation
 * is written by hand as the markup the pane should hold, never read back through
 * the renderer. The rendering boundary's corpus is
 * reply-markdown-security.test.tsx.
 */
/** The markup without its module-hashed class names: the elements and their attributes are the expectation. */
const html = (text: string, caret = false) => renderToStaticMarkup(<ReplyProse text={text} caret={caret} />).replace(/ class="[^"]*"/g, "");
const visible = (markup: string) => markup.replace(/<[^>]+>/g, "");

describe("every supported form renders as its element", () => {
  it("one to three hashes and a space make a heading; four stay literal", () => {
    expect(html("# What changed")).toBe('<h4 data-level="1">What changed</h4>');
    expect(html("## What changed")).toBe('<h4 data-level="2">What changed</h4>');
    expect(html("### Notes")).toBe('<h4 data-level="3">Notes</h4>');
    expect(html("#### Four")).toBe("<p>#### Four</p>");
    expect(html("#NoSpace")).toBe("<p>#NoSpace</p>");
  });
  it("paired double asterisks are bold, single are italics, backticks are code", () => {
    expect(html("The layer **parks** changed.")).toBe("<p>The layer <strong>parks</strong> changed.</p>");
    expect(html("Say *equal intervals* instead.")).toBe("<p>Say <em>equal intervals</em> instead.</p>");
    expect(html("Fill from `ST_Area(geom)` now.")).toBe("<p>Fill from <code>ST_Area(geom)</code> now.</p>");
  });
  it("a hyphen or asterisk item makes an unordered list; a number with a dot or parenthesis an ordered one", () => {
    expect(html("- Breaks: 0.4 and 1.1 ha\n- Ramp: kelp")).toBe("<ul><li>Breaks: 0.4 and 1.1 ha</li><li>Ramp: kelp</li></ul>");
    expect(html("* one\n* two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(html("1. Add the column\n2) Style on it")).toBe("<ol><li>Add the column</li><li>Style on it</li></ol>");
  });
  it("a bracketed text with an absolute http or https address is a link that opens apart, with no opener and no referrer", () => {
    expect(html("See the [spatial docs](https://duckdb.org/docs/extensions/spatial/functions#st_area).")).toBe(
      '<p>See the <a href="https://duckdb.org/docs/extensions/spatial/functions#st_area" target="_blank" rel="noopener noreferrer">spatial docs</a>.</p>');
    expect(html("[plain](http://example.test/a?b=1)")).toBe('<p><a href="http://example.test/a?b=1" target="_blank" rel="noopener noreferrer">plain</a></p>');
  });
  it("paragraphs join their lines with a space and split at a blank line", () => {
    expect(html("one\ntwo\n\nthree")).toBe("<p>one two</p><p>three</p>");
  });
  it("inline forms nest inside headings, list items and paragraphs, and inside each other, while block forms do not nest", () => {
    expect(html("## The **parks** layer")).toBe('<h4 data-level="2">The <strong>parks</strong> layer</h4>');
    expect(html("- Run `SELECT 1` on [it](https://x.test)")).toBe('<ul><li>Run <code>SELECT 1</code> on <a href="https://x.test" target="_blank" rel="noopener noreferrer">it</a></li></ul>');
    expect(html("**bold with `code` and *em***")).toBe("<p><strong>bold with <code>code</code> and <em>em</em></strong></p>");
    // The reverse nesting: the italics' closer is the run's last star, the bold's the two before
    // it.
    expect(html("*italic with **bold***")).toBe("<p><em>italic with <strong>bold</strong></em></p>");
    expect(html("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
    expect(html("**a *b* c**")).toBe("<p><strong>a <em>b</em> c</strong></p>");
    expect(html("- item\n  - nested?")).toBe("<ul><li>item</li><li>nested?</li></ul>");
    expect(html("- # not a heading")).toBe("<ul><li># not a heading</li></ul>");
  });
});

describe("an unsafe destination yields no anchor at all", () => {
  it.each([
    ["javascript", "[click](javascript:alert(1))"],
    ["data", "[click](data:text/html,<script>alert(1)</script>)"],
    ["vbscript", "[click](vbscript:MsgBox(1))"],
    ["relative", "[click](/api/maps)"],
    ["bare word", "[click](example.test)"],
  ])("%s: the construct stays literal", (_name, text) => {
    const markup = html(text);
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("href");
    expect(visible(markup).replace(/&lt;/g, "<").replace(/&gt;/g, ">")).toBe(text);
  });
  it("the destination check itself admits only absolute http and https", () => {
    expect(safeLinkHref("https://duckdb.org/x")).toBe("https://duckdb.org/x");
    expect(safeLinkHref("HTTP://example.test")).toBe("HTTP://example.test");
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/plain,x", "vbscript:x", "ftp://x.test", "//x.test", "https://a b", "https://x.test/<script>"]) {
      expect(safeLinkHref(bad), bad).toBeNull();
    }
  });
});

describe("an unsupported construct holding supported delimiters keeps every source character", () => {
  it("a table row with emphasis and inline code", () => {
    const table = "| Column | Note |\n|---|---|\n| `area_m2` | **missing** |";
    expect(html(table)).toBe('<p data-literal="true">| Column | Note |\n|---|---|\n| `area_m2` | **missing** |</p>');
  });
  it("a blockquote with emphasis and inline code", () => {
    expect(html("> **Note:** run `ANALYZE` first")).toBe('<p data-literal="true">&gt; **Note:** run `ANALYZE` first</p>');
  });
  it("an image in markdown's spelling never becomes an exclamation mark beside a link", () => {
    const markup = html("![parks](https://x.test/parks.png)");
    expect(markup).toBe("<p>![parks](https://x.test/parks.png)</p>");
  });
  it("a reference link keeps its brackets and its inner emphasis as typed", () => {
    expect(html("[**docs**][spatial]")).toBe("<p>[**docs**][spatial]</p>");
  });
  it("raw HTML is text", () => {
    expect(html('<img src="https://x.test/a.png" onerror="alert(1)">')).toBe("<p>&lt;img src=&quot;https://x.test/a.png&quot; onerror=&quot;alert(1)&quot;&gt;</p>");
  });
  it("raw HTML is opaque: supported delimiters inside a tag stay as typed", () => {
    expect(html('The <img alt="**parks**"> tag')).toBe("<p>The &lt;img alt=&quot;**parks**&quot;&gt; tag</p>");
    // The opaque unit is the tag: text between two tags is text, and the tags keep every character.
    expect(html("<b>*em*</b> outside *em*")).toBe("<p>&lt;b&gt;<em>em</em>&lt;/b&gt; outside <em>em</em></p>");
    expect(html("<!-- **not bold** -->")).toBe("<p>&lt;!-- **not bold** --&gt;</p>");
    // A lone angle bracket is not a tag: the text after it still parses.
    expect(html("a < b and **c**")).toBe("<p>a &lt; b and <strong>c</strong></p>");
  });
  it("an unpaired delimiter stays literal", () => {
    expect(html("**open bold")).toBe("<p>**open bold</p>");
    expect(html("a * b * c")).toBe("<p>a * b * c</p>");
    expect(html("`open code")).toBe("<p>`open code</p>");
    expect(html("[open link](https://x.test")).toBe("<p>[open link](https://x.test</p>");
    expect(html("a ** b")).toBe("<p>a ** b</p>");
  });
});

describe("an escaped delimiter stays literal and its unescaped twin does not", () => {
  it.each([
    ["asterisks", "\\*not em\\*", "*not em*", "*em*", "<em>em</em>"],
    ["double asterisks", "\\*\\*not bold\\*\\*", "**not bold**", "**bold**", "<strong>bold</strong>"],
    ["backticks", "\\`not code\\`", "`not code`", "`code`", "<code>code</code>"],
    ["brackets", "\\[not](https://x.test)", "[not](https://x.test)", "[yes](https://x.test)", '<a href="https://x.test" target="_blank" rel="noopener noreferrer">yes</a>'],
  ])("%s", (_name, escaped, literal, twin, element) => {
    expect(html(escaped)).toBe(`<p>${literal}</p>`);
    expect(html(twin)).toBe(`<p>${element}</p>`);
  });
  it("a backslash before anything but punctuation stays a backslash", () => {
    expect(html("C:\\path\\to")).toBe("<p>C:\\path\\to</p>");
  });
});

describe("a streamed prefix is literal until its closing delimiter arrives", () => {
  it("bold, code and a link each render only once closed", () => {
    expect(html("The layer **par")).toBe("<p>The layer **par</p>");
    expect(html("The layer **parks**")).toBe("<p>The layer <strong>parks</strong></p>");
    expect(html("Fill from `ST_Ar")).toBe("<p>Fill from `ST_Ar</p>");
    expect(html("See the [docs](https://du")).toBe("<p>See the [docs](https://du</p>");
    expect(html("See the [docs](https://duckdb.org)")).toBe('<p>See the <a href="https://duckdb.org" target="_blank" rel="noopener noreferrer">docs</a></p>');
  });
  it("the caret sits inline at the end of the last block, and alone on empty text", () => {
    expect(html("one\n\n- a\n- b", true)).toBe('<p>one</p><ul><li>a</li><li>b<span data-caret="true" aria-hidden="true"></span></li></ul>');
    expect(html("", true)).toBe('<span data-caret="true" aria-hidden="true"></span>');
    expect(html("one")).not.toContain("data-caret");
  });
});

describe("the inline tree", () => {
  it("is what the elements are built from", () => {
    expect(parseInline("a **b** `c` [d](https://e.test) *f*")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " " },
      { kind: "code", text: "c" },
      { kind: "text", text: " " },
      { kind: "link", href: "https://e.test", children: [{ kind: "text", text: "d" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "f" }] },
    ]);
  });
});
