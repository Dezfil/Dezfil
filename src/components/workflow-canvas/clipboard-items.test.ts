import { describe, it, expect } from "vitest";
import { CLIPBOARD_MARK, readClipboardItem, writeClipboardItem } from "./clipboard-items";

/**
 * The clipboard item's reading: an independently authored item reads
 * back; the writer's raw text carries exactly the mark, the kind and the
 * fields; malformed and unsupported text reads as nothing. The reader is
 * never tested against the writer alone.
 */
describe("the clipboard item", () => {
  it("reads an independently authored node item and a note item", () => {
    const node = `{"${CLIPBOARD_MARK}":1,"kind":"node","operation":"buffer","parameters":{"input":"stations","distance":150,"name":"stations_buffer"}}`;
    expect(readClipboardItem(node)).toEqual({ kind: "node", operation: "buffer", parameters: { input: "stations", distance: 150, name: "stations_buffer" } });
    const note = `{"${CLIPBOARD_MARK}":1,"kind":"note","text":"---\\nlabel: note\\n---\\nhello","color":"green","w":320,"h":176}`;
    expect(readClipboardItem(note)).toEqual({ kind: "note", text: "---\nlabel: note\n---\nhello", color: "green", w: 320, h: 176 });
  });

  it("writes the mark, the version and the fields, and nothing else", () => {
    const raw = writeClipboardItem({ kind: "node", operation: "buffer", parameters: { input: "a", distance: 1, name: "a_buffer" } });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([CLIPBOARD_MARK, "kind", "operation", "parameters"].sort());
    expect(parsed[CLIPBOARD_MARK]).toBe(1);
    expect(parsed.operation).toBe("buffer");
    expect(parsed.parameters).toEqual({ input: "a", distance: 1, name: "a_buffer" });
  });

  it("reads foreign, malformed and unsupported text as nothing", () => {
    for (const text of [
      "",
      "SELECT 1",
      "{",
      "[]",
      "null",
      `{"kind":"node","operation":"buffer","parameters":{}}`,
      `{"${CLIPBOARD_MARK}":2,"kind":"node","operation":"buffer","parameters":{}}`,
      `{"${CLIPBOARD_MARK}":1,"kind":"edge"}`,
      `{"${CLIPBOARD_MARK}":1,"kind":"node","operation":"","parameters":{}}`,
      `{"${CLIPBOARD_MARK}":1,"kind":"node","operation":"buffer","parameters":[]}`,
      `{"${CLIPBOARD_MARK}":1,"kind":"node","operation":"buffer"}`,
      `{"${CLIPBOARD_MARK}":1,"kind":"note","text":"x","color":"orange","w":1,"h":1}`,
      `{"${CLIPBOARD_MARK}":1,"kind":"note","text":"x","color":"green","w":0,"h":1}`,
      `{"${CLIPBOARD_MARK}":1,"kind":"note","text":${JSON.stringify("x".repeat(4001))},"color":"green","w":1,"h":1}`,
    ]) {
      expect(readClipboardItem(text), text.slice(0, 60)).toBeNull();
    }
  });

  it("refuses parameters that are not plain data", () => {
    expect(readClipboardItem(`{"${CLIPBOARD_MARK}":1,"kind":"node","operation":"buffer","parameters":{"distance":"1e400"}}`)).not.toBeNull();
    expect(readClipboardItem(`{"${CLIPBOARD_MARK}":1,"kind":"node","operation":"buffer","parameters":{"distance":1e400}}`)).toBeNull();
  });
});
