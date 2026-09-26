import { describe, expect, it } from "vitest";
import { ProjectHomeReader } from "./home-reader";

describe("action continuation ownership", () => {
  it("rejects a departed action before and after a return visit, including reused tokens", () => {
    const reader = new ProjectHomeReader(() => new Promise(() => {}));
    const a = { id: "a" };
    void reader.activate(a);
    const action = reader.beginAction(a);
    expect(reader.ownsAction(action)).toBe(true);
    reader.dispose(a);
    expect(reader.ownsAction(action)).toBe(false);
    const b = { id: "b" };
    void reader.activate(b);
    expect(reader.ownsAction(action)).toBe(false);
    reader.dispose(b);
    void reader.activate(a);
    expect(reader.ownsAction(action)).toBe(false);
    expect(reader.ownsAction(reader.beginAction(a))).toBe(true);
    reader.dispose(a);
  });
});
