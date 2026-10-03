import { describe, expect, it } from "vitest";
import { DocumentSequence, fieldIntent } from "./document-sequence";

describe("one document sequence", () => {
  it("delays other layers and history until the accepted predecessor, with camera independent", async () => {
    const sequence = new DocumentSequence();
    sequence.accept({ editRevision: "first" });
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const sql = sequence.enqueue(async () => { sent.push(`sql:${sequence.revision}`); await slow; sequence.accept({ editRevision: "second" }); });
    const style = sequence.enqueue(async () => { sent.push(`style:${sequence.revision}`); sequence.accept({ editRevision: "third" }); });
    const history = sequence.enqueue(async () => { sent.push(`undo:${sequence.revision}`); });
    await Promise.resolve();
    sent.push("camera");
    expect(sent).toEqual(["sql:first", "camera"]);
    release();
    await Promise.all([sql, style, history]);
    expect(sent).toEqual(["sql:first", "camera", "style:second", "undo:third"]);
  });

  it("composes changed fields, removals and identified list items against accepted state", () => {
    const before = { style: { opacity: 1, fill: "red", label: "old" as string | undefined }, widgets: [{ id: "a", title: "old", visible: true }] };
    const intent = fieldIntent(before, { style: { opacity: 0.5, fill: "red", label: undefined }, widgets: [{ id: "a", title: "new", visible: true }] });
    expect(intent({ style: { opacity: 1, fill: "blue", label: "old" }, widgets: [{ id: "a", title: "old", visible: false }, { id: "b", title: "added", visible: true }] }))
      .toEqual({ style: { opacity: 0.5, fill: "blue" }, widgets: [{ id: "a", title: "new", visible: false }, { id: "b", title: "added", visible: true }] });
  });

  it("fences work from a disposed editor and never replays a refusal", async () => {
    const sequence = new DocumentSequence();
    const seen: number[] = [];
    const first = sequence.enqueue(async () => { seen.push(1); sequence.dispose(); });
    const second = sequence.enqueue(async () => { seen.push(2); });
    await first;
    await expect(second).rejects.toThrow(/closed/);
    expect(seen).toEqual([1]);
  });
});
