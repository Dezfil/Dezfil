import { afterEach, describe, expect, it, vi } from "vitest";
import { wire } from "./fetch-wire";
import { LayoutSaveCoordinator, type LayoutSnapshot, type SaveState } from "./layout-save-coordinator";
import type { LayoutRead } from "./placement";

const W = "w1";
const LOCK = "Canvas locked. Unlock to edit.";
const EMPTY: LayoutRead = { steps: {}, sources: {}, notes: [], updatedAt: null };

describe("the production layout save coordinator", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a failed snapshot recoverable but sends no Retry while the canvas is locked", async () => {
    const w = wire();
    vi.stubGlobal("fetch", w.fetch);
    const states: SaveState[] = [];
    const said: string[] = [];
    let reason: string | null = null;
    const coordinator = new LayoutSaveCoordinator(W, EMPTY, {
      graph: { members: [], edges: [], presentSourceCount: 0 },
      onState: (state) => states.push(state),
      lockReason: () => reason,
      say: (text) => said.push(text),
    });
    const snapshot: LayoutSnapshot = { positions: { n1: { x: 48, y: 40 } }, notes: [] };

    coordinator.save(snapshot);
    await w.settle();
    const first = w.pending("PUT", `/api/recipes/${W}/layout`)[0];
    expect(first.body).toEqual({ steps: { n1: { x: 48, y: 40 } }, sources: {}, notes: [] });
    first.cut();
    await w.settle();
    const failed = states.at(-1);
    expect(failed?.kind).toBe("failed");
    if (!failed || failed.kind !== "failed") throw new Error("the failed save offered no Retry");

    reason = LOCK;
    failed.retry();
    await w.settle();
    const escaped = w.pending("PUT", `/api/recipes/${W}/layout`).map((call) => ({ method: call.method, path: call.path, body: call.body }));
    expect({ count: escaped.length, escaped }).toEqual({ count: 0, escaped: [] });
    expect(said.at(-1)).toBe(LOCK);
    expect(states.at(-1)).toBe(failed);

    reason = null;
    failed.retry();
    await w.settle();
    const retry = w.pending("PUT", `/api/recipes/${W}/layout`)[0];
    expect(retry.body).toEqual(first.body);
    retry.ok({ layout: { ...EMPTY, steps: { n1: { x: 48, y: 40 } }, updatedAt: "2026-08-30T00:00:00.000Z" } });
    await w.settle();
    expect(states.at(-1)?.kind).toBe("saved");
  });
});
