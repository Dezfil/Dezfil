import { describe, expect, it, vi } from "vitest";
import { editHeaders, declaredRevisionArguments } from "./edit-basis";

describe("explicit edit basis", () => {
  it("uses the captured basis without a read, refresh or replay", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const captured = { editRevision: "a".repeat(32) };
      const headers = editHeaders(captured, { "content-type": "application/json" });
      expect(headers.get("X-Edit-Revision")).toBe(captured.editRevision);
      expect(headers.get("content-type")).toBe("application/json");
      expect(fetch).not.toHaveBeenCalled();
      expect(() => editHeaders({ editRevision: null })).toThrow(/Read this item/);
    } finally { vi.unstubAllGlobals(); }
  });

  it("adds tool arguments only at the declared revision location", () => {
    const basis = { editRevision: "b".repeat(32) };
    const args = { map_id: "map" };
    expect(declaredRevisionArguments({}, args, basis)).toEqual(args);
    expect(declaredRevisionArguments({ headerParams: [{ name: "X-Edit-Revision", argument: "expected_revision" }] }, args, basis))
      .toEqual({ ...args, expected_revision: basis.editRevision });
    expect(args).toEqual({ map_id: "map" });
  });
});
