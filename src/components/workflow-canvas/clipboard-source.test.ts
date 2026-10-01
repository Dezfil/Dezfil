import { describe, expect, it } from "vitest";
import { pasteSource, readClipboardItem, writeClipboardItem, type NodeClipboardItem } from "./clipboard-items";

/**
 * A copied node carries the workflow its values were written in. Pasted into
 * another workflow, the add says so, and the API carries the values over
 * from there; pasted back into the same workflow, nothing is said and
 * nothing moves. Text from before the source travelled still pastes.
 */
describe("a copied node's source workflow", () => {
  const node: NodeClipboardItem = { kind: "node", operation: "sql_step", parameters: { sql: "SELECT * FROM staged" }, source: "w1" };

  it("survives the clipboard round trip", () => {
    expect(readClipboardItem(writeClipboardItem(node))).toEqual(node);
    const older = JSON.stringify({ "dezfil-canvas-item": 1, kind: "node", operation: "sql_step", parameters: {} });
    expect(readClipboardItem(older)).toEqual({ kind: "node", operation: "sql_step", parameters: {} });
    for (const source of [3, "", null]) {
      expect(readClipboardItem(JSON.stringify({ "dezfil-canvas-item": 1, kind: "node", operation: "sql_step", parameters: {}, source }))).toBeNull();
    }
  });

  it("is named on a paste into another workflow, and only there", () => {
    expect(pasteSource(node, "w2")).toEqual({ writtenIn: { kind: "workflow", id: "w1" } });
    expect(pasteSource(node, "w1")).toEqual({});
    expect(pasteSource({ ...node, source: undefined }, "w2")).toEqual({});
  });
});
