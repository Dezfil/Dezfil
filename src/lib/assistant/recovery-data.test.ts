import { describe, expect, it } from "vitest";
import { compactReceipt, jsonBytes } from "./recovery-data";
import type { RunReceipt } from "./runs";

/** The terminal compaction marks what it drops: an
 * action whose arguments went carries `omitted`; one that never had
 * arguments does not, so unavailable detail is never confused with a
 * call that carried none. */
describe("compactReceipt marks dropped arguments", () => {
  it("sets omitted exactly on the actions whose arguments it removed", () => {
    const receipt: RunReceipt = {
      id: "r", state: "completed", text: "x".repeat(600), incomplete: false,
      actions: [
        { id: "a", tool: "run_sql", args: { sql: "SELECT " + "1, ".repeat(200) }, status: "succeeded" },
        { id: "b", tool: "list_tables", status: "succeeded" },
      ],
    };
    const bound = jsonBytes(receipt) - 100;
    const compact = compactReceipt(receipt, bound, true);
    expect(compact.incomplete).toBe(true);
    expect(compact.actions[0]).toEqual({ id: "a", tool: "run_sql", status: "succeeded", omitted: true });
    expect(compact.actions[1]).toEqual({ id: "b", tool: "list_tables", status: "succeeded" });
    expect(jsonBytes(compact)).toBeLessThanOrEqual(bound);
    // The live compaction keeps arguments and marks nothing.
    const live = compactReceipt(receipt, bound, false);
    expect(live.actions[0].args).toBeDefined();
    expect(live.actions[0].omitted).toBeUndefined();
  });
});
