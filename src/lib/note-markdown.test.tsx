import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderNoteBody } from "./note-markdown";

const html = (body: string) =>
  renderToStaticMarkup(<>{renderNoteBody(body)}</>);

describe("note formatting subset", () => {
  it("renders paragraphs, line breaks, bold, italic, and lists", () => {
    expect(html("first\n\nsecond")).toBe("<p>first</p><p>second</p>");
    expect(html("line one\nline two")).toBe("<p>line one<br/>line two</p>");
    expect(html("**bold** and *quiet*")).toBe(
      "<p><strong>bold</strong> and <em>quiet</em></p>",
    );
    expect(html("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("links open in a new tab, http(s) only", () => {
    expect(html("[OSM](https://osm.org)")).toBe(
      '<p><a href="https://osm.org" target="_blank" rel="noopener noreferrer">OSM</a></p>',
    );
    // Hostile schemes never become links — the text stays literal.
    expect(html("[x](javascript:alert(1))")).toBe(
      "<p>[x](javascript:alert(1))</p>",
    );
    expect(html("[x](data:text/html,hi)")).toBe(
      "<p>[x](data:text/html,hi)</p>",
    );
  });

  it("raw HTML and scripts render as inert text", () => {
    expect(html("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
    expect(html('<img src=x onerror="alert(1)">')).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
    );
  });

  it("keeps headings and backticks literal without the canvas's option", () => {
    expect(html("# Title\n`code`")).toBe("<p># Title<br/>`code`</p>");
  });
});

const canvas = (body: string) =>
  renderToStaticMarkup(<>{renderNoteBody(body, { headings: true, code: true, inertImages: true })}</>);

describe("the canvas's additions", () => {
  it("renders three heading levels, inline code, and the rest as before", () => {
    expect(canvas("# One\n## Two\n### Three\nplain")).toBe("<h1>One</h1><h2>Two</h2><h3>Three</h3><p>plain</p>");
    expect(canvas("#### Four")).toBe("<p>#### Four</p>");
    expect(canvas("use `ST_Buffer` here")).toBe("<p>use <code>ST_Buffer</code> here</p>");
    expect(canvas("**bold** and [OSM](https://osm.org)")).toBe(
      '<p><strong>bold</strong> and <a href="https://osm.org" target="_blank" rel="noopener noreferrer">OSM</a></p>',
    );
    expect(canvas("- a `b`\n- **c**")).toBe("<ul><li>a <code>b</code></li><li><strong>c</strong></li></ul>");
  });

  it("image syntax stays inert inside a heading too", () => {
    expect(canvas("# ![alt](https://x.example/a.png)")).toBe("<h1>![alt](https://x.example/a.png)</h1>");
  });

  it("a heading inside a paragraph splits it; the rest stays inert text", () => {
    expect(canvas("intro\n## Head\nafter\nmore")).toBe("<p>intro</p><h2>Head</h2><p>after<br/>more</p>");
    // A run of list lines under a heading is a list, and a prose line after it a paragraph.
    expect(canvas("## Head\n- a\n- b\ntail")).toBe("<h2>Head</h2><ul><li>a</li><li>b</li></ul><p>tail</p>");
    expect(canvas("# One\n- a\n- b")).toBe("<h1>One</h1><ul><li>a</li><li>b</li></ul>");
    expect(canvas("![alt](https://x.example/a.png)")).toBe("<p>![alt](https://x.example/a.png)</p>");
    expect(canvas("see ![alt](https://x.example/a.png) and [ok](https://osm.org)")).toBe(
      '<p>see ![alt](https://x.example/a.png) and <a href="https://osm.org" target="_blank" rel="noopener noreferrer">ok</a></p>',
    );
    expect(canvas("| a | b |\n|---|---|")).toBe("<p>| a | b |<br/>|---|---|</p>");
    expect(canvas("<b>x</b> [x](javascript:alert(1))")).toBe("<p>&lt;b&gt;x&lt;/b&gt; [x](javascript:alert(1))</p>");
  });
});

describe("a list starts at any dash line", () => {
  it("after a paragraph line, before one, and after a heading", () => {
    expect(html("Here:\n- a\n- b")).toBe("<p>Here:</p><ul><li>a</li><li>b</li></ul>");
    expect(html("- a\n- b\nafter")).toBe("<ul><li>a</li><li>b</li></ul><p>after</p>");
    expect(html("one\n- a\ntwo\n- b")).toBe("<p>one</p><ul><li>a</li></ul><p>two</p><ul><li>b</li></ul>");
    expect(renderToStaticMarkup(<>{renderNoteBody("## T\n- a\n- b", { headings: true })}</>)).toBe(
      "<h2>T</h2><ul><li>a</li><li>b</li></ul>",
    );
  });
});
