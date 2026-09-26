import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OperationDef } from "@/lib/operations/catalog";
import { OperationPicker } from "./OperationPicker";

/** Both row branches — the suggestions and the grouped catalog —
 * carry the operation's group for the rest hue, and draw the set. */
const op = (id: string, group: string, symbol: string): OperationDef =>
  ({ id, group, label: id, symbol, blurb: "", parameters: [] }) as unknown as OperationDef;

describe("the picker's rows under the two-tone set", () => {
  it("both branches carry the group and the set's grid", () => {
    const buffer = op("buffer", "Proximity", "buffer");
    const html = renderToStaticMarkup(
      <OperationPicker operations={[buffer]} error={null} suggestions={[buffer]} suggestedFor="stations" onPick={() => {}} />,
    );
    const suggested = html.indexOf("data-operation-suggested");
    const listed = html.indexOf('data-operation="buffer"');
    expect(suggested).toBeGreaterThan(-1);
    expect(listed).toBeGreaterThan(-1);
    expect(html.slice(suggested, suggested + 220)).toContain('data-grp="Proximity"');
    expect(html.slice(listed, listed + 220)).toContain('data-grp="Proximity"');
    expect(html).toContain('viewBox="0 0 40 40"');
  });
});
