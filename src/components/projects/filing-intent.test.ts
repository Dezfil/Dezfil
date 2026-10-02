import { describe, expect, it, vi } from "vitest";
import { filingIntent, membershipBody, subjectBasis } from "./filing-intent";
import { composeChange, emptySelection } from "./picker-model";
import type { DependencyWire } from "./add-model";
import { transferDocument } from "../sharing/share-client";

describe("displayed filing and transfer bases", () => {
  it("keeps the displayed subject and selected producer bases without a refresh", () => {
    const subject = { kind: "map" as const, id: "m", name: "Map", projectId: null, editRevision: "map-shown" };
    const deps = [
      { id: "d", owned: true, producer: { id: "w", name: "Producer", editRevision: "producer-shown" } },
      { id: "other", owned: true, producer: { id: "unpicked", name: "Other", editRevision: "other-shown" } },
    ] as DependencyWire[];
    const intent = filingIntent(subject, deps, { datasets: new Set(["d"]), workflows: new Set(["w"]) });
    expect(intent.bases).toEqual({ "map:m": "map-shown", "workflow:w": "producer-shown" });
    expect(membershipBody(intent)).toEqual({ addMaps: ["m"], addRecipes: ["w"], addTables: ["d"], expectedRevisions: intent.bases });
  });

  it("keeps an explicitly selected producer's displayed basis ahead of its dependency projection", () => {
    const sel = { ...emptySelection(), maps: new Set(["m"]), workflows: new Set(["w"]) };
    const deps = [{ id: "d", producer: { id: "w", name: "Producer", editRevision: "later-dependency" } }] as DependencyWire[];
    const reads = new Map([
      ["m", { status: "ready" as const, deps }],
      ["w", { status: "ready" as const, deps: [] }],
    ]);
    const intent = composeChange(sel, reads, undefined, { "map:m": "map-shown", "workflow:w": "workflow-shown" });
    expect(intent.bases).toEqual({ "map:m": "map-shown", "workflow:w": "workflow-shown" });
    expect(subjectBasis({ kind: "dataset", id: "d", name: "Data", projectIds: [] })).toEqual({});
  });

  it("routes the captured transfer basis directly, retaining a refusal without replay", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message: "Changed" } }), { status: 409 }));
    try {
      await expect(transferDocument("map", { id: "m", editRevision: "shown" }, "bo")).rejects.toThrow("Changed");
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0];
      expect(url).toBe("/api/maps/m/transfer");
      expect(new Headers(init?.headers).get("X-Edit-Revision")).toBe("shown");
      expect(JSON.parse(String(init?.body))).toEqual({ to: "bo" });
    } finally { fetcher.mockRestore(); }
  });
});
