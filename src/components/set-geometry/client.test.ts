import { afterEach, describe, expect, it, vi } from "vitest";
import { GeometryApiError, geometryClient } from "./client";

const calls: { url: string; init?: RequestInit }[] = [];
function answer(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => { calls.length = 0; vi.unstubAllGlobals(); });

describe("the set-geometry client reads", () => {
  it("a preview carries the read revision and the choice to the published route", async () => {
    answer(200, { revision: "r1", canApply: true });
    await geometryClient.preview("trips 1", "r1", { format: "pair", columns: ["a", "b"], epsg: 25833 });
    expect(calls[0].url).toBe("/api/tables/trips%201/geometry/preview");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ expectedRevision: "r1", choice: { format: "pair", columns: ["a", "b"], epsg: 25833 } });
  });
  it("apply sends the choice with the revision as a PUT on the geometry resource", async () => {
    answer(200, { revision: "r2", table: {} });
    await geometryClient.set("trips", "r1", { format: "wkt", columns: ["column01"] });
    expect(calls[0].url).toBe("/api/tables/trips/geometry");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ expectedRevision: "r1", choice: { format: "wkt", columns: ["column01"] } });
  });
  it("a refusal reaches the caller with the API's own sentence and code, unchanged", async () => {
    answer(409, { error: { code: "input_changed", message: "The dataset changed. Inspect its geometry again before continuing." } });
    const failure = await geometryClient.set("trips", "r0", { format: "wkt", columns: ["column01"] }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GeometryApiError);
    expect(failure).toMatchObject({ code: "input_changed", status: 409, message: "The dataset changed. Inspect its geometry again before continuing." });
  });
  it("inspect reads the geometry resource and the projection list takes an optional code", async () => {
    answer(200, { revision: "r1", candidates: [] });
    await geometryClient.inspect("trips");
    expect(calls[0].url).toBe("/api/tables/trips/geometry");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    await geometryClient.projections();
    expect(calls[1].url).toBe("/api/geometry/projections");
    await geometryClient.projections("EPSG:31467");
    expect(calls[2].url).toBe("/api/geometry/projections?epsg=EPSG%3A31467");
  });
});
