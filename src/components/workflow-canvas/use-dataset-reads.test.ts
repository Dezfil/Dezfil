import { describe, it, expect } from "vitest";
import { DatasetReader, datasetPart, type DatasetKey } from "./use-dataset-reads";

/** A fetcher whose answers resolve when the test says so, in any order. */
function fakeFetcher() {
  const pending: { path: string; resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  const fetcher = (path: string) =>
    new Promise<Response>((resolve, reject) => {
      pending.push({ path, resolve, reject });
    });
  const answer = (path: string, body: unknown, status = 200) => {
    const i = pending.findIndex((p) => p.path === path);
    if (i === -1) throw new Error(`nothing pending for ${path}`);
    const [p] = pending.splice(i, 1);
    p.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  };
  const drop = (path: string) => {
    const i = pending.findIndex((p) => p.path === path);
    if (i === -1) throw new Error(`nothing pending for ${path}`);
    const [p] = pending.splice(i, 1);
    p.reject(new TypeError("Failed to fetch"));
  };
  return { fetcher, answer, drop, pending };
}

const key = (o: Partial<DatasetKey> & { name: string }): DatasetKey => ({ id: `id_${o.name}`, producedAt: "2026-08-26T10:00:00Z", renewal: 0, features: false, ...o });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the dataset reads", () => {
  it("a stale answer never lands over a newer selection, whichever lands first", async () => {
    const f = fakeFetcher();
    const reader = new DatasetReader(f.fetcher);
    reader.read(key({ name: "alpha" }));
    expect(reader.state.inspection).toEqual({ status: "reading" });
    reader.read(key({ name: "beta" }));
    // beta answers first, then alpha's slow answer arrives: beta stays.
    f.answer("/api/tables/beta", { name: "beta", rowCount: 2 });
    await tick();
    expect(reader.state.inspection).toEqual({ status: "read", value: { name: "beta", rowCount: 2 } });
    f.answer("/api/tables/alpha", { name: "alpha", rowCount: 1 });
    await tick();
    expect(reader.state.inspection).toEqual({ status: "read", value: { name: "beta", rowCount: 2 } });
    // The other order: the newer selection's read is still reading while the older lands.
    reader.read(key({ name: "gamma" }));
    reader.read(key({ name: "delta" }));
    f.answer("/api/tables/gamma", { name: "gamma" });
    await tick();
    expect(reader.state.inspection).toEqual({ status: "reading" });
    f.answer("/api/tables/delta", { name: "delta" });
    await tick();
    expect(reader.state.inspection).toEqual({ status: "read", value: { name: "delta" } });
  });

  it("the features race the same way, a late failure lands nowhere, and the state names its dataset so a lagging one is never taken for the next", async () => {
    const f = fakeFetcher();
    const reader = new DatasetReader(f.fetcher);
    reader.read(key({ name: "alpha", features: true }));
    reader.read(key({ name: "beta", features: true }));
    expect(reader.state.key).toBe(datasetPart(key({ name: "beta", features: true })));
    // beta's reads land; alpha's features and its failed inspection arrive after: beta stays whole.
    f.answer("/api/tables/beta/features?sample=1", { ok: true, featureCount: 2 });
    f.answer("/api/tables/beta", { name: "beta" });
    await tick();
    f.answer("/api/tables/alpha/features?sample=1", { ok: true, featureCount: 99 });
    f.drop("/api/tables/alpha");
    await tick();
    expect(reader.state).toEqual({ key: datasetPart(key({ name: "beta", features: true })), inspection: { status: "read", value: { name: "beta" } }, features: { status: "read", value: { ok: true, featureCount: 2 } } });
    // The other order: delta's late failures must not dress gamma, still reading.
    reader.read(key({ name: "delta", features: true }));
    reader.read(key({ name: "gamma", features: true }));
    f.drop("/api/tables/delta");
    f.drop("/api/tables/delta/features?sample=1");
    await tick();
    expect(reader.state).toEqual({ key: datasetPart(key({ name: "gamma", features: true })), inspection: { status: "reading" }, features: { status: "reading" } });
  });

  it("the features are read only while wanted, once per key; a re-run under the same name is a new key", async () => {
    const f = fakeFetcher();
    const reader = new DatasetReader(f.fetcher);
    const k = key({ name: "pts" });
    reader.read(k);
    expect(reader.state.features).toBeNull();
    expect(f.pending.map((p) => p.path)).toEqual(["/api/tables/pts"]);
    reader.read({ ...k, features: true });
    expect(f.pending.map((p) => p.path)).toEqual(["/api/tables/pts", "/api/tables/pts/features?sample=1"]);
    f.answer("/api/tables/pts", { name: "pts" });
    f.answer("/api/tables/pts/features?sample=1", { ok: true, featureCount: 3 });
    await tick();
    expect(reader.state.features).toEqual({ status: "read", value: { ok: true, featureCount: 3 } });
    // Map hidden: the features are dropped, the inspection kept, nothing re-read.
    reader.read(k);
    expect(reader.state.features).toBeNull();
    expect(reader.state.inspection.status).toBe("read");
    expect(f.pending).toEqual([]);
    // The same dataset produced again: both read anew.
    reader.read({ ...k, producedAt: "2026-08-26T11:00:00Z", features: true });
    expect(f.pending.map((p) => p.path)).toEqual(["/api/tables/pts", "/api/tables/pts/features?sample=1"]);
    expect(reader.state.inspection).toEqual({ status: "reading" });
    // A renewal alone re-reads too.
    f.answer("/api/tables/pts", { name: "pts" });
    f.answer("/api/tables/pts/features?sample=1", { ok: true });
    await tick();
    reader.read({ ...k, producedAt: "2026-08-26T11:00:00Z", features: true, renewal: 1 });
    expect(f.pending.length).toBe(2);
  });

  it("a failed read holds its message and Retry reads again; not found is gone; clearing the key clears the reads", async () => {
    const f = fakeFetcher();
    const reader = new DatasetReader(f.fetcher);
    reader.read(key({ name: "pts", features: true }));
    f.drop("/api/tables/pts");
    f.answer("/api/tables/pts/features?sample=1", { error: { message: "Too many." } }, 500);
    await tick();
    expect(reader.state.inspection).toEqual({ status: "failed", message: "Couldn't read the dataset. Is the server reachable?" });
    expect(reader.state.features?.status).toBe("failed");
    reader.retry();
    expect(reader.state.inspection).toEqual({ status: "reading" });
    expect(reader.state.features).toEqual({ status: "reading" });
    f.answer("/api/tables/pts", { name: "pts" });
    f.answer("/api/tables/pts/features?sample=1", { ok: true });
    await tick();
    expect(reader.state.inspection.status).toBe("read");
    expect(reader.state.features?.status).toBe("read");
    reader.read(key({ name: "gone" }));
    f.answer("/api/tables/gone", { error: { code: "not_found", message: "No table named gone." } }, 404);
    await tick();
    expect(reader.state.inspection).toEqual({ status: "gone" });
    // The features alone finding the table gone (a deletion racing after the
    // inspection): the signal survives the Map tab falling away.
    reader.read(key({ name: "late", features: true }));
    f.answer("/api/tables/late", { name: "late", id: "id_late" });
    f.answer("/api/tables/late/features?sample=1", { error: { code: "not_found", message: "No table named late." } }, 404);
    await tick();
    expect(reader.state.features).toEqual({ status: "gone" });
    reader.read(key({ name: "late", features: false }));
    expect(reader.state.features).toEqual({ status: "gone" });
    expect(reader.state.inspection.status).toBe("read");
    reader.read(null);
    expect(reader.state).toEqual({ key: null, inspection: { status: "reading" }, features: null });
  });
});
