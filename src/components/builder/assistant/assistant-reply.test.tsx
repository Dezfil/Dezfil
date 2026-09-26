import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantReply } from "./AssistantReply";
import { AssistantRecord } from "./AssistantRecord";
import { CORPUS, UNSAFE_LINKS } from "./reply-markdown-security.test";

/**
 * The reply composed: prose through the renderer, code blocks and
 * proposals as left them, the caret while streaming, and the corpus
 * through the composed boundary. The record's lines stay literal: a
 * label holding markdown characters shows them as typed.
 */
const strip = (markup: string) => markup.replace(/ class="[^"]*"/g, "");
const port = { active: () => false, start: () => true };

describe("the composed reply", () => {
  it("renders prose as elements and a code block as before", () => {
    const markup = strip(renderToStaticMarkup(<AssistantReply text={"Try **this**:\n```sql\nSELECT 1;\n```\nDone."} insertable={false} />));
    expect(markup).toBe('<div data-turn-answer="true"><p>Try <strong>this</strong>:</p><pre data-lang="sql">SELECT 1;</pre><p>Done.</p></div>');
  });
  it("offers a completed SQL block as a proposal where the host can insert, and a streaming open fence as text with no action", () => {
    const insertable = renderToStaticMarkup(<AssistantReply text={"Try:\n```sql\nSELECT 1;\n```"} insertable onInsert={() => {}} />);
    expect(insertable).toContain("data-proposal");
    expect(insertable).toContain(">Insert into editor</button>");
    const open = renderToStaticMarkup(<AssistantReply text={"Try:\n```sql\nSELECT 1"} insertable onInsert={() => {}} streaming />);
    expect(open).not.toContain("data-proposal");
    expect(open).toContain('data-streaming="true"');
    expect(open, "no caret inside an open fence").not.toContain("data-caret");
  });
  it("marks the active prose segment with the caret while streaming and not once settled", () => {
    expect(renderToStaticMarkup(<AssistantReply text="Thinking about **it" insertable={false} streaming />)).toContain("data-caret");
    expect(renderToStaticMarkup(<AssistantReply text="Thinking about **it**" insertable={false} />)).not.toContain("data-caret");
  });
  it("keeps the corpus literal through the composed boundary", () => {
    for (const { payload } of [...CORPUS, ...UNSAFE_LINKS]) {
      const markup = renderToStaticMarkup(<AssistantReply text={payload} insertable={false} />);
      const tags = markup.match(/<[a-z][^>]*>/gi) ?? [];
      expect(tags.filter((tag) => /^<(script|img|iframe|a)\b/i.test(tag) || /\s(on[a-z]+|src)=/i.test(tag)), payload).toEqual([]);
    }
  });
});

describe("the record stays literal", () => {
  it("a line's label and a refusal's reason show their markdown characters as typed", () => {
    const markup = renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} entries={[
      { id: "a", tool: "**teleport**", label: "**teleport**", status: "refused", inputs: [], omitted: false, failure: { code: "invalid_request", message: "Unknown tool: **teleport**" } },
    ]} />);
    expect(markup).toContain("Unknown tool: **teleport**");
    expect(markup).not.toContain("<strong");
  });
});
