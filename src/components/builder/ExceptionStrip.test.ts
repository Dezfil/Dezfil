import { describe, expect, it } from "vitest";
import { stripCopy } from "./ExceptionStrip";
import type { OutputStatus } from "./drawer/recipe-notes";

/**
 * The strip's copy and its precedence. The stale tones are proven live by
 * the browser journey; what a journey cannot cheaply force is a failed
 * latest attempt over a stale condition — so the precedence rule is held
 * here, where both sides are constructed.
 */
function status(over: Partial<OutputStatus>): OutputStatus {
  return {
    recipeId: "r",
    stepId: "s",
    operation: "spatial_join",
    operationLabel: "Spatial join",
    output: { id: "t", name: "out" },
    condition: "current",
    causes: [],
    failed: null,
    fingerprint: "f",
    ...over,
  };
}

describe("the strip's copy", () => {
  it("failure outranks stale in the one strip", () => {
    expect(
      stripCopy(
        status({
          condition: "stale",
          causes: [{ reason: "source_changed", tableId: "a", tableName: "src" }],
          failed: { code: "sql_rejected", message: "boom" },
        }),
      ),
    ).toBe("Spatial join failed · re-run");
  });

  it("one direct cause names its table; upstream reads out of date", () => {
    expect(
      stripCopy(
        status({
          condition: "stale",
          causes: [{ reason: "source_changed", tableId: "a", tableName: "src" }],
        }),
      ),
    ).toBe("src changed · re-run");
    expect(
      stripCopy(
        status({
          condition: "stale",
          causes: [{ reason: "upstream_stale", tableId: "a", tableName: "mid" }],
        }),
      ),
    ).toBe("mid is out of date · re-run");
  });

  it("several causes count instead of naming", () => {
    expect(
      stripCopy(
        status({
          condition: "stale",
          causes: [
            { reason: "source_changed", tableId: "a", tableName: "one" },
            { reason: "upstream_re_ran", tableId: "b", tableName: "two" },
          ],
        }),
      ),
    ).toBe("2 inputs changed · re-run");
  });

  it("a current, unfailed output has no strip at all", () => {
    expect(stripCopy(status({}))).toBeNull();
  });
});
