import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantConfirmation } from "./AssistantConfirmation";

/** The card: the gate's
 * resolved words, two buttons, no identifier, and no sentence about
 * sending another message, which the ruling on the parked turn retired. */
describe("the confirmation card", () => {
  const pending = { id: "p1", runId: "r1", tool: "delete_table", args: { name: "parks_raw" },
    confirmation: { target: "Delete parks_raw?", consequence: "This deletes the dataset and its data. Layers that read it will lose their source." } };
  it("carries the target, the consequence and two buttons, no operation identifier and no sending sentence", () => {
    const html = renderToStaticMarkup(<AssistantConfirmation pending={pending} promptId="q" busy={false} resolve={() => {}} />);
    const visible = html.replace(/<[^>]+>/g, " ");
    expect(visible).toContain("Delete parks_raw?");
    expect(visible).toContain("This deletes the dataset and its data.");
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain(">Confirm</button>"); expect(html).toContain(">Cancel</button>");
    expect(visible).not.toContain("delete_table");
    // The card's paragraphs are the target and the consequence, nothing else; the status
    // region is the pane's one announcer's, not the card's.
    expect(html.match(/<p\b/g)).toHaveLength(2);
    expect(html).not.toContain('role="status"');
    expect(visible).not.toMatch(/sending another message/i);
  });
  it("renders nothing but the empty status with no pending action", () => {
    const html = renderToStaticMarkup(<AssistantConfirmation pending={null} promptId="q" busy={false} resolve={() => {}} />);
    expect(html).not.toContain("data-confirmation");
  });
});
