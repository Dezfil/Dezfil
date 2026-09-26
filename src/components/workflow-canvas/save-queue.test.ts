import { describe, it, expect } from "vitest";
import { SaveQueue } from "./save-queue";

const at = (x: number) => ({ positions: { a: { x, y: 0 } }, notes: [{ id: "n", text: `at ${x}` }] });

describe("serialized saves", () => {
  it("sends one write at a time and only the newest of those that waited, notes and all", () => {
    const q = new SaveQueue<ReturnType<typeof at>>();
    expect(q.offer(at(1))).toEqual(at(1));
    expect(q.busy).toBe(true);
    // Two moves while the first write is on the wire: the middle one is
    // never sent; the newest replaces it.
    expect(q.offer(at(2))).toBeNull();
    expect(q.offer(at(3))).toBeNull();
    expect(q.landed()).toEqual(at(3));
    expect(q.busy).toBe(true);
    expect(q.landed()).toBeNull();
    expect(q.busy).toBe(false);
    expect(q.offer(at(4))).toEqual(at(4));
  });
});
