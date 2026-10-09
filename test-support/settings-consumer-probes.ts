import https from "node:https";
import type { ClientRequest } from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { rm } from "node:fs/promises";
import { expect, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { writeStoredSettings } from "../src/lib/settings/store";
import { testAccountScope } from "../src/lib/test-support/accounts";
import { receiveUpload } from "../src/lib/ingest/receive";
import { resolveRemoteSource } from "../src/lib/ingest/remote";
import * as network from "../src/lib/net/remote-fetch";
import * as engine from "../src/lib/duckdb";
import { boundedEvaluation } from "../src/lib/query/bounded";
import { executeQuery } from "../src/lib/query/execute";
import { assertOsmAreaWithinBudget } from "../src/lib/osm/import";
import { assertAreaWithinBudget } from "../src/lib/overture/import";
import * as lane from "../src/lib/operations/lane";
import { submitRun } from "../src/lib/operations/run";
import { getJob } from "../src/lib/metadata/jobs";
import { renderMapImage, renderQueueState } from "../src/lib/export/render-image";
import { initialDefinition } from "../src/lib/export/image-definition";
import { admitPublishedRequest } from "../src/lib/publish/source-admission";
import { socketRequest } from "../src/lib/assistant/testing/socket-request";
import { SERVICE_NUMBER_PROBES } from "./service-number-probes";

type Probe = (db: Database) => Promise<void> | void;
const payload = Buffer.alloc(1.5 * 1024 ** 2, 32);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const definition = initialDefinition({ appearance: "light", camera: { lng: 0, lat: 0, zoom: 2 }, canvasWidth: 800,
  legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null }, { width: 800, scale: 1 });

/** The clock is fake; the deadline and refusal are the production consumer's.
 * Inspect settlement before awaiting, so an ignored budget fails instead of hanging. */
async function deadline(pending: Promise<unknown>, milliseconds: number, code: string) {
  let outcome: unknown;
  const observed = pending.then(value => { outcome = value; }, error => { outcome = error; });
  await vi.advanceTimersByTimeAsync(milliseconds - 1);
  expect(outcome, "work must remain admitted before its deadline").toBeUndefined();
  await vi.advanceTimersByTimeAsync(2);
  expect(outcome, "the stored deadline must refuse new work").toMatchObject({ code });
  await observed;
}

function image(db: Database, id: string, held: Promise<void>) {
  return renderMapImage(testAccountScope(db, "admin"), { mapId: id, baseUrl: "http://instance.test", credential: "fixture", definition,
    driver: { launch: async () => ({ render: async () => { await held; return { png: new Uint8Array([1]) }; }, close: async () => {}, kill: () => {} }) } });
}

function area(key: "osmMaxKm2" | "overtureMaxKm2", consume: () => unknown): Probe {
  return db => {
    writeStoredSettings({ [key]: 200 }, db);
    expect(consume).not.toThrow(); // One tenth of a degree is about 124 km² here.
    writeStoredSettings({ [key]: 1 }, db);
    expect(consume).toThrow(expect.objectContaining({ code: "area_too_large", status: 413 }));
  };
}

function publicWindow(key: "publicRateLimit" | "publicTileRateLimit"): Probe {
  return db => {
    const request = socketRequest(new Request("http://instance.test/published/fixture"));
    const consume = () => admitPublishedRequest(request, key === "publicRateLimit" ? "pub" : "tile");
    vi.useFakeTimers(); vi.setSystemTime(1000);
    writeStoredSettings({ [key]: 2 }, db);
    consume(); consume();
    expect(consume).toThrow(expect.objectContaining({ code: "rate_limited", status: 429 }));
    writeStoredSettings({ [key]: 3 }, db);
    consume();
    expect(consume).toThrow(expect.objectContaining({ code: "rate_limited" }));
    vi.setSystemTime(11_000);
    expect(consume).not.toThrow();
  };
}

/** Independent boundary observations, keyed by the consumption inventory's setting.
 * These call operations, never the resolver or the configuration read. */
export const numericConsumerProbes: Record<string, Probe> = {
  uploadMaxMb: async db => {
    const request = () => {
      const form = new FormData(); form.set("file", new File([payload], "large.csv"));
      return new Request("http://instance.test/api/tables", { method: "POST", body: form });
    };
    writeStoredSettings({ uploadMaxMb: 2 }, db);
    const received = await receiveUpload(request()); await rm(received.tmpPath);
    writeStoredSettings({ uploadMaxMb: 1 }, db);
    await expect(receiveUpload(request())).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
  },
  remoteMaxMb: async db => {
    for (const declared of [true, false]) {
      vi.spyOn(network, "openRemote").mockImplementation(async () => ({ statusCode: 200,
        headers: declared ? { "content-length": String(payload.length) } : {},
        body: Readable.from([payload]) as network.RemoteResponse["body"], finalUrl: "https://example.test/large.csv" }));
      writeStoredSettings({ remoteMaxMb: 2 }, db);
      const source = await resolveRemoteSource("https://example.test/large.csv"); await source.cleanup();
      writeStoredSettings({ remoteMaxMb: 1 }, db);
      await expect(resolveRemoteSource("https://example.test/large.csv")).rejects.toMatchObject({ code: "remote_too_large", status: 413 });
    }
  },
  remoteTimeoutS: async db => {
    // Stall at the socket adapter, keeping the real remote-fetch timer and import error.
    const requested = Promise.withResolvers<void>();
    const events = new EventEmitter();
    let failure: Error | undefined;
    const request = Object.assign(events, { end() { requested.resolve(); }, destroy(error?: Error) {
      if (error) { failure = error; events.emit("error", error); }
    } });
    vi.spyOn(https, "request").mockReturnValue(request as ClientRequest);
    vi.useFakeTimers();
    writeStoredSettings({ remoteTimeoutS: 10 }, db);
    const pending = resolveRemoteSource("https://example.test/stalled.csv");
    void pending.catch(() => {});
    try {
      await requested.promise;
      await vi.advanceTimersByTimeAsync(9999); expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      expect(failure).toMatchObject({ code: "remote_timeout", status: 504 });
      await expect(pending).rejects.toMatchObject({ code: "remote_timeout", message: expect.stringContaining("10 s") });
    }
    finally { request.destroy(new Error("Fixture released")); await pending.catch(() => {}); }
  },
  osmMaxKm2: area("osmMaxKm2", () => assertOsmAreaWithinBudget([0, 0, 0.1, 0.1])),
  overtureMaxKm2: area("overtureMaxKm2", () => assertAreaWithinBudget("places", [0, 0, 0.1, 0.1])),
  queryTimeoutS: async db => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof engine.connectQueryInstance>>>();
    vi.spyOn(engine, "connectQueryInstance").mockReturnValue(held.promise);
    vi.useFakeTimers(); writeStoredSettings({ queryTimeoutS: 5 }, db);
    const pending = boundedEvaluation(async () => {}, { scope: testAccountScope(db, "admin") });
    try { await deadline(pending, 5000, "query_timeout"); }
    finally { held.reject(new Error("Fixture released")); await pending.catch(() => {}); }
  },
  previewRows: async db => {
    const scope = testAccountScope(db, "admin");
    writeStoredSettings({ previewRows: 20 }, db);
    const complete = await executeQuery(scope, "SELECT range AS n FROM range(20)");
    expect(complete).toMatchObject({ rowCount: 20, previewTruncated: false });
    expect(complete.preview).toHaveLength(20);
    writeStoredSettings({ previewRows: 10 }, db);
    const truncated = await executeQuery(scope, "SELECT range AS n FROM range(20)");
    expect(truncated).toMatchObject({ rowCount: 20, previewTruncated: true });
    expect(truncated.preview).toHaveLength(10);
    expect(truncated.preview.map(row => Number(row.n))).toEqual(Array.from({ length: 10 }, (_, i) => i));
  },
  operationConcurrency: async db => {
    const held = Promise.withResolvers<void>(), order: string[] = [];
    writeStoredSettings({ operationConcurrency: 1 }, db);
    try {
      for (const id of ["a", "b", "c"]) lane.submit(id, async () => { order.push(id); await held.promise; });
      expect(lane.laneDepth()).toEqual({ executing: 1, waiting: 2 });
      expect(order).toEqual(["a"]);
      writeStoredSettings({ operationConcurrency: 2 }, db);
      expect(lane.laneDepth()).toEqual({ executing: 2, waiting: 1 });
      expect(order).toEqual(["a", "b"]);
    } finally { held.resolve(); await lane.laneSettled(); }
  },
  operationQueueMax: async db => {
    const held = Promise.withResolvers<void>();
    writeStoredSettings({ operationConcurrency: 1, operationQueueMax: 1 }, db);
    try {
      lane.submit("active", () => held.promise); lane.submit("waiting", async () => {});
      const consume = () => lane.submit("next", async () => {});
      expect(consume).toThrow(expect.objectContaining({ code: "operation_queue_full", status: 503 }));
      writeStoredSettings({ operationQueueMax: 2 }, db);
      expect(consume).not.toThrow();
      expect(lane.laneDepth()).toEqual({ executing: 1, waiting: 2 });
    } finally { held.resolve(); await lane.laneSettled(); }
  },
  operationTimeoutS: async db => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof engine.connectQueryInstance>>>();
    vi.spyOn(engine, "connectQueryInstance").mockReturnValue(held.promise);
    vi.useFakeTimers(); writeStoredSettings({ queryTimeoutS: 5, operationTimeoutS: 30 }, db);
    const job = submitRun(testAccountScope(db, "admin"), { operationId: "sql_step", parameters: {}, sql: "SELECT 1 AS n", name: "timed" });
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(getJob(job.id, db)?.state).toBe("running");
      await vi.advanceTimersByTimeAsync(2);
      expect(getJob(job.id, db)).toMatchObject({ state: "failed", errorCode: "operation_timeout", errorMessage: expect.stringContaining("30s") });
    } finally { held.reject(new Error("Fixture released")); await lane.laneSettled(); }
  },
  exportRenderConcurrency: async db => {
    const held = Promise.withResolvers<void>(), runs: Promise<unknown>[] = [];
    writeStoredSettings({ exportRenderConcurrency: 1 }, db);
    try {
      runs.push(image(db, "a", held.promise), image(db, "b", held.promise)); await flush();
      expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });
      writeStoredSettings({ exportRenderConcurrency: 2 }, db); await flush();
      expect(renderQueueState()).toEqual({ active: 2, waiting: 0 });
    } finally { held.resolve(); await Promise.allSettled(runs); }
  },
  exportRenderTimeoutS: async db => {
    const held = Promise.withResolvers<void>();
    vi.useFakeTimers(); writeStoredSettings({ exportRenderTimeoutS: 10 }, db);
    const pending = image(db, "timed", held.promise);
    try { await deadline(pending, 10_000, "render_timeout"); }
    finally { held.resolve(); await pending.catch(() => {}); }
  },
  publicRateLimit: publicWindow("publicRateLimit"),
  publicTileRateLimit: publicWindow("publicTileRateLimit"),
  ...SERVICE_NUMBER_PROBES,
};
