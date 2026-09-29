import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance, withConnection } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { ensureTileDirs, tileScratchDir } from "@/lib/tiles/paths";
import { POINTS_VIZ } from "@/lib/viz";
import { EvaluationCancelled } from "@/lib/api/errors";
import {
  exportLayerResult,
  exportQueryResult,
  isLayerExportFormat,
  type ExportableLayer,
} from "./layer-export";
import {
  LAYER_DOWNLOAD_PREPARED_TTL_MS,
  LayerDownloadTicketStore,
} from "./layer-download-tickets";

/**
 * Layer data export: the export carries the layer's effective result —
 * filters included on both roads (SQL predicate and stored builder filter)
 * — and every documented format reopens as that format with geometry
 * preserved. The two-geometry fixture proves the first-geometry rule:
 * primary stays spatial, the second survives as WKT.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    [
      "name,category,lon,lat,riders",
      "alexanderplatz,u,13.410,52.520,900",
      "hackescher,s,13.402,52.523,700",
      "zoo,u,13.330,52.510,500",
      "sudkreuz,s,13.360,52.480,120",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
  ensureTileDirs();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function layer(overrides: Partial<ExportableLayer> = {}): ExportableLayer {
  return {
    name: "Stations",
    sql: "SELECT name, category, riders, geometry FROM stations",
    filters: [],
    viz: POINTS_VIZ,
    ...overrides,
  };
}

describe("layer export — the effective result", () => {
  it("a SQL predicate narrows the export", async () => {
    const file = await exportLayerResult(
      testAccountScope(), layer({
        sql: "SELECT name, geometry FROM stations WHERE riders > 400",
      }),
      "geojson",
    );
    const parsed = JSON.parse(await readFile(file.path, "utf8")) as {
      features: unknown[];
    };
    expect(parsed.features).toHaveLength(3);
    await file.cleanup();
  });

  it("a stored builder filter narrows the export — the load-bearing road", async () => {
    // The SQL is untouched; only the stored filter carries the predicate.
    // An export of the raw SQL would pass the sibling test and fail here.
    const file = await exportLayerResult(
      testAccountScope(), layer({
        filters: [{ field: "riders", kind: "range", min: 400, max: null }],
      }),
      "geojson",
    );
    const parsed = JSON.parse(await readFile(file.path, "utf8")) as {
      features: { properties: Record<string, unknown> }[];
    };
    expect(parsed.features).toHaveLength(3);
    await file.cleanup();
  });
});

describe("layer export — every format reopens", () => {
  it("GeoParquet reopens spatially with the filtered count", async () => {
    const file = await exportLayerResult(
      testAccountScope(), layer({
        filters: [{ field: "category", kind: "values", values: ["u"] }],
      }),
      "geoparquet",
    );
    expect(file.filename).toBe("Stations.parquet");
    // Reopen on the app's own engine: spatial columns and count survive.
    const target = file.path.replace(/'/g, "''");
    const rows = await withConnection(async (conn) => {
      const read = await conn.runAndReadAll(
        `SELECT name, ST_AsText(geometry) AS wkt FROM read_parquet('${target}') ORDER BY name`,
      );
      return read.getRowObjects() as { name: string; wkt: string }[];
    });
    expect(rows.map((r) => r.name)).toEqual(["alexanderplatz", "zoo"]);
    expect(rows[0].wkt).toMatch(/^POINT/);
    await file.cleanup();
  });

  it("GeoJSON reopens as GeoJSON with geometry", async () => {
    const file = await exportLayerResult(testAccountScope(), layer(), "geojson");
    const parsed = JSON.parse(await readFile(file.path, "utf8")) as {
      type: string;
      features: { geometry: { type: string } }[];
    };
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features).toHaveLength(4);
    expect(parsed.features[0].geometry.type).toBe("Point");
    await file.cleanup();
  });

  it("CSV keeps every column with geometry as WKT", async () => {
    const file = await exportLayerResult(testAccountScope(), layer(), "csv");
    const text = await readFile(file.path, "utf8");
    const [header, ...rows] = text.trim().split("\n");
    expect(header).toBe("name,category,riders,geometry");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/POINT \(/);
    await file.cleanup();
  });

  it("a two-geometry result keeps the first spatial and the second as WKT", async () => {
    const twoGeom = layer({
      name: "Origin/Dest",
      sql: `SELECT name, geometry, ST_Point(lon + 0.01, lat + 0.01) AS dest
            FROM stations`,
    });
    const file = await exportLayerResult(testAccountScope(), twoGeom, "geoparquet");
    const target = file.path.replace(/'/g, "''");
    const row = await withConnection(async (conn) => {
      const read = await conn.runAndReadAll(
        `SELECT ST_AsText(geometry) AS geom_wkt, dest,
                typeof(dest) AS dest_type
         FROM read_parquet('${target}') LIMIT 1`,
      );
      return read.getRowObjects()[0] as Record<string, string>;
    });
    expect(row.geom_wkt).toMatch(/^POINT/);
    expect(row.dest_type).toBe("VARCHAR");
    expect(row.dest).toMatch(/^POINT/);

    // GeoJSON takes the same projection: one feature geometry, dest as a
    // WKT property rather than a dropped column.
    const gj = await exportLayerResult(testAccountScope(), twoGeom, "geojson");
    const parsed = JSON.parse(await readFile(gj.path, "utf8")) as {
      features: {
        geometry: { type: string };
        properties: Record<string, unknown>;
      }[];
    };
    expect(parsed.features[0].geometry.type).toBe("Point");
    expect(String(parsed.features[0].properties.dest)).toMatch(/^POINT/);
    await gj.cleanup();
    await file.cleanup();
  });
});

describe("layer export — the O→D visualization road", () => {
  it("an OD-viz export keeps the endpoint geometry columns as WKT", async () => {
    // The render path's OD compilation EXCLUDEs mapped geometry
    // endpoints (one geometry for downstream). A naive export through it
    // silently loses origin and destination — the exact loss the
    // geometry rule forbids. This fixture is the load-bearing one: an
    // actual OD viz over two geometry columns.
    const odLayer = layer({
      name: "Trips",
      sql: `SELECT name, geometry, ST_Point(lon + 0.01, lat + 0.01) AS dest
            FROM stations`,
      viz: {
        type: "line",
        origin: { kind: "geometry", field: "geometry" },
        dest: { kind: "geometry", field: "dest" },
        height: 0,
      },
    });
    const file = await exportLayerResult(testAccountScope(), odLayer, "geojson");
    const parsed = JSON.parse(await readFile(file.path, "utf8")) as {
      features: {
        geometry: { type: string };
        properties: Record<string, unknown>;
      }[];
    };
    // The feature geometry is the O→D line…
    expect(parsed.features).toHaveLength(4);
    expect(parsed.features[0].geometry.type).toBe("LineString");
    // …and BOTH endpoint columns survive as WKT values beside it.
    expect(String(parsed.features[0].properties.geometry)).toMatch(/^POINT/);
    expect(String(parsed.features[0].properties.dest)).toMatch(/^POINT/);
    expect(parsed.features[0].properties.name).toBeDefined();
    await file.cleanup();
  });
});

describe("layer export — the agent road", () => {
  it("the tool round-trips the real route's bytes through the envelope", async () => {
    const { createMap } = await import("@/lib/map-service");
    const { createLayer } = await import("@/lib/layer-service");
    const { GET } = await import("@/app/api/layers/[id]/export/[format]/route");
    const { buildTools } = await import("@/lib/tools/tools");
    const { executeTool } = await import("@/lib/tools/execute");

    const map = createMap(testAccountScope(), "m");
    const stored = await createLayer(testAccountScope(), map.id, {
      name: "Stations",
      sql: "SELECT name, geometry FROM stations",
    });

    // Bridge fetch to the actual route handler: the tool exercises the
    // same code path a browser download does, no server needed.
    const routeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const m = /\/api\/layers\/([^/]+)\/export\/([^/?]+)/.exec(String(url));
      if (!m) throw new Error(`unexpected url: ${String(url)}`);
      return GET(testAccountRequest(new Request(String(url), init)), {
        params: Promise.resolve({
          id: decodeURIComponent(m[1]),
          format: decodeURIComponent(m[2]),
        }),
      });
    }) as typeof fetch;

    const tool = buildTools().find((t) => t.name === "export_layer_data");
    expect(tool).toBeDefined();
    const result = await executeTool(
      tool!,
      { id: stored.id, format: "geoparquet" },
      "http://127.0.0.1:3000",
      routeFetch,
    );
    expect(result.ok).toBe(true);
    const body = result.body as {
      attachment: { filename: string; content_base64: string };
    };
    expect(body.attachment.filename).toBe("Stations.parquet");
    const bytes = Buffer.from(body.attachment.content_base64, "base64");
    // A parquet file leads with the PAR1 magic — bytes, not mangled text.
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("PAR1");
    // And the engine reopens the exact bytes as a table again.
    const tmp = path.join(dir, "roundtrip.parquet");
    await writeFile(tmp, bytes);
    const count = await withConnection(async (conn) => {
      const read = await conn.runAndReadAll(
        `SELECT count(*) AS n FROM read_parquet('${tmp.replace(/'/g, "''")}')`,
      );
      return Number((read.getRowObjects()[0] as { n: unknown }).n);
    });
    expect(count).toBe(4);
  });
});

describe("layer export — lifecycle and hygiene", () => {
  it("writes inside the scratch directory and cleanup removes the file", async () => {
    const file = await exportLayerResult(testAccountScope(), layer(), "csv");
    expect(path.dirname(file.path)).toBe(tileScratchDir());
    await expect(stat(file.path)).resolves.toBeTruthy();
    await file.cleanup();
    await expect(stat(file.path)).rejects.toThrow();
  });

  it("a failing export leaves no file behind", async () => {
    await expect(
      exportLayerResult(testAccountScope(), layer({ sql: "SELECT nope FROM missing" }), "csv"),
    ).rejects.toMatchObject({ code: "sql_error" });
    const { readdir } = await import("node:fs/promises");
    const remaining = (await readdir(tileScratchDir())).filter((f) =>
      f.startsWith("export-"),
    );
    expect(remaining).toEqual([]);
  });

  it("caller abort reclaims an in-progress real export scratch file", async () => {
    const controller = new AbortController();
    const previousTimeout = process.env.DEZFIL_QUERY_TIMEOUT_S;
    resetQueryInstance();

    let exporting: ReturnType<typeof exportLayerResult> | undefined;
    let settled: Promise<void> | undefined;
    let failSafe: ReturnType<typeof setTimeout> | undefined;
    try {
      // Pay the cold hardened-instance setup before the cancellation clock:
      // the test is about interrupting COPY, not extension startup.
      const warm = await exportLayerResult(testAccountScope(), layer(), "csv");
      await warm.cleanup();
      process.env.DEZFIL_QUERY_TIMEOUT_S = "5";

      // Independent of the assertions below, never allow the writer more
      // than one second to run. The configured five-second evaluation budget
      // is a second hard stop if the scratch observation itself fails.
      failSafe = setTimeout(() => controller.abort(), 1_000);
      exporting = exportLayerResult(
        testAccountScope(), layer({
          sql: `SELECT i,
                       ST_Point((i % 360)::DOUBLE, (i % 180)::DOUBLE) AS geometry
                FROM range(10000000) AS generated(i)`,
        }),
        "csv",
        controller.signal,
      );
      // Attach the rejection observer before cancellation so the test never
      // relies on an unhandled-rejection grace period.
      settled = exporting.then(
        () => undefined,
        () => undefined,
      );

      await vi.waitFor(
        async () => {
          const partial = (await readdir(tileScratchDir())).filter((name) =>
            name.startsWith("export-"),
          );
          expect(partial).toHaveLength(1);
          await expect(
            stat(path.join(tileScratchDir(), partial[0])),
          ).resolves.toBeTruthy();
        },
        { timeout: 1_500, interval: 5 },
      );

      const cancelledAt = Date.now();
      controller.abort();

      await expect(exporting).rejects.toBeInstanceOf(EvaluationCancelled);
      expect(Date.now() - cancelledAt).toBeLessThan(2_000);
      await vi.waitFor(async () => {
        const residue = (await readdir(tileScratchDir())).filter((name) =>
          name.startsWith("export-"),
        );
        expect(residue).toEqual([]);
      });

      // Interruption is connection-local; the hardened instance remains fit
      // for the next real export after the cancelled writer has drained.
      const follower = await exportLayerResult(testAccountScope(), layer(), "csv");
      await expect(stat(follower.path)).resolves.toBeTruthy();
      await follower.cleanup();
    } finally {
      if (failSafe) clearTimeout(failSafe);
      controller.abort();
      // Do not race past native work and leave it writing in the background.
      // Its five-second evaluation budget is the bounded teardown fail-safe.
      if (settled) await settled;
      if (previousTimeout === undefined) {
        delete process.env.DEZFIL_QUERY_TIMEOUT_S;
      } else {
        process.env.DEZFIL_QUERY_TIMEOUT_S = previousTimeout;
      }
      resetQueryInstance();
    }
  }, 15_000);

  it("keeps an emitted-but-unreachable real artifact until the production expiry reaper removes it", async () => {
    const file = await exportLayerResult(testAccountScope(), layer(), "csv");
    const cleanup = vi.spyOn(file, "cleanup");
    const store = new LayerDownloadTicketStore();
    const binding = { layerId: "layer-expiry", format: "csv" } as const;

    try {
      vi.useFakeTimers();
      const ticket = store.prepare(testAccountScope(), binding, {
        ...file,
        size: (await stat(file.path)).size,
      });

      await vi.advanceTimersByTimeAsync(LAYER_DOWNLOAD_PREPARED_TTL_MS - 1);
      // Do not call status here: a correctly bound observation transfers
      // preparation ownership. This arm represents an emitted ticket that
      // never reached any observer, so only the file can witness pre-expiry.
      expect(cleanup).not.toHaveBeenCalled();
      await expect(stat(file.path)).resolves.toBeTruthy();

      await vi.advanceTimersByTimeAsync(1);
      expect(store.status(testAccountScope(), ticket, binding)).toBe("failed");
      expect(cleanup).toHaveBeenCalledOnce();
      await cleanup.mock.results[0].value;
      await expect(stat(file.path)).rejects.toThrow();
    } finally {
      await store.dispose();
      vi.useRealTimers();
      await file.cleanup();
    }
  });

  it("a free-text layer name becomes a safe filename", async () => {
    const file = await exportLayerResult(
      testAccountScope(), layer({ name: 'we/ird "name" !' }),
      "csv",
    );
    expect(file.filename).toBe("we ird name.csv");
    await file.cleanup();
  });

  it("rejects unknown formats at the type gate", () => {
    expect(isLayerExportFormat("geoparquet")).toBe(true);
    expect(isLayerExportFormat("shapefile")).toBe(false);
    expect(isLayerExportFormat(null)).toBe(false);
  });
});

describe("layer export — private native-download hand-off", () => {
  async function stored(sql = "SELECT name, geometry FROM stations") {
    const { createMap } = await import("@/lib/map-service");
    const { createLayer } = await import("@/lib/layer-service");
    const { updateLayerFields } = await import("@/lib/metadata/maps");
    const map = createMap(testAccountScope(), "download-map");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "Stations",
      sql: "SELECT name, geometry FROM stations",
    });
    if (sql !== layer.sql) updateLayerFields(layer.id, { sql });
    return layer;
  }

  async function route(
    id: string,
    format: string,
    search = "",
    signal?: AbortSignal,
  ) {
    const { GET } = await import("@/app/api/layers/[id]/export/[format]/route");
    return GET(
      testAccountRequest(new Request(
        `http://localhost/api/layers/${id}/export/${format}${search}`,
        { signal },
      )),
      { params: Promise.resolve({ id, format }) },
    );
  }

  async function exportScratch(): Promise<string[]> {
    return (await readdir(tileScratchDir())).filter((name) =>
      name.startsWith("export-"),
    );
  }

  async function prepare(id: string, format = "csv"): Promise<string> {
    const response = await route(id, format, "?__ui_prepare=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["ticket"]);
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return body.ticket as string;
  }

  async function release(
    id: string,
    ticket: string,
    format = "csv",
  ): Promise<Response> {
    return route(
      id,
      format,
      `?__ui_status=${encodeURIComponent(ticket)}&__ui_release=1`,
    );
  }

  it("keeps the bare GET attachment bytes and headers unchanged", async () => {
    const layer = await stored();
    const response = await route(layer.id, "csv");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="Stations.csv"',
    );
    expect(response.headers.get("cache-control")).toBeNull();
    const length = Number(response.headers.get("content-length"));
    const text = await response.text();
    expect(text).toContain("name,geometry");
    expect(Buffer.byteLength(text)).toBe(length);
    await vi.waitFor(async () => expect(await exportScratch()).toEqual([]));
  });

  it("keeps the bare GET coded-error envelope and leaves no residue", async () => {
    const layer = await stored("SELECT nope FROM missing");
    const response = await route(layer.id, "csv");

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBeNull();
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("sql_error");
    expect(body.error.message).not.toContain(process.cwd());
    expect(await exportScratch()).toEqual([]);
  });

  it("leaves an unrecognized private lookalike on the direct attachment road", async () => {
    const layer = await stored();
    const response = await route(layer.id, "csv", "?__ui_prepare=not-one");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="Stations.csv"',
    );
    expect(await response.text()).toContain("name,geometry");
  });

  it("prepares once, atomically consumes once, and reports streamed completion", async () => {
    const layer = await stored();
    const ticket = await prepare(layer.id);
    const statusUrl = `?__ui_status=${encodeURIComponent(ticket)}`;

    const preparedStatus = await route(layer.id, "csv", statusUrl);
    expect(await preparedStatus.json()).toEqual({ status: "prepared" });
    expect(preparedStatus.headers.get("cache-control")).toBe("no-store");

    const downloadUrl = `?__ui_download=${encodeURIComponent(ticket)}`;
    const first = await route(layer.id, "csv", downloadUrl);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(first.headers.get("content-disposition")).toBe(
      'attachment; filename="Stations.csv"',
    );
    expect(first.headers.get("cache-control")).toBe("no-store");

    const replay = await route(layer.id, "csv", downloadUrl);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("cache-control")).toBe("no-store");
    expect((await replay.json()) as unknown).toEqual({
      error: {
        code: "invalid_request",
        message: "This prepared download is no longer available.",
      },
    });

    expect(await first.text()).toContain("name,geometry");
    await vi.waitFor(async () => {
      const settled = await route(layer.id, "csv", statusUrl);
      expect(await settled.json()).toEqual({ status: "complete" });
    });
    await vi.waitFor(async () => expect(await exportScratch()).toEqual([]));
    expect((await release(layer.id, ticket)).status).toBe(204);
  });

  it("a failed preparation keeps its coded error and creates no ticket residue", async () => {
    const layer = await stored("SELECT nope FROM missing");
    const response = await route(layer.id, "csv", "?__ui_prepare=1");

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sql_error");
    expect(await exportScratch()).toEqual([]);
  });

  it("releases an unobserved ticket when cancellation lands after the handler returns", async () => {
    const layer = await stored();
    const controller = new AbortController();
    const { layerDownloadTickets } = await import("./layer-download-tickets");
    const originalPrepare =
      layerDownloadTickets.prepare.bind(layerDownloadTickets);
    let mintedTicket: string | null = null;
    let preparedPath: string | null = null;
    vi.spyOn(layerDownloadTickets, "prepare").mockImplementation(
      (scope, binding, file, signal) => {
        preparedPath = file.path;
        mintedTicket = originalPrepare(scope, binding, file, signal);
        return mintedTicket;
      },
    );

    const response = await route(
      layer.id,
      "csv",
      "?__ui_prepare=1",
      controller.signal,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mintedTicket).not.toBeNull();
    expect(preparedPath).not.toBeNull();
    expect(await exportScratch()).toHaveLength(1);
    await expect(stat(preparedPath!)).resolves.toBeTruthy();
    // The response object exists, but no client action has read its body,
    // observed status, claimed the download, or released it. Handler return
    // was the former false ownership boundary.
    controller.abort();
    expect(
      layerDownloadTickets.status(testAccountScope(), mintedTicket!, {
        layerId: layer.id,
        format: "csv",
      }),
    ).toBeNull();
    await vi.waitFor(async () => expect(await exportScratch()).toEqual([]));
    await expect(stat(preparedPath!)).rejects.toThrow();
    await response.body?.cancel();
  });

  it("a first bound status observation transfers prepare ownership", async () => {
    const layer = await stored();
    const controller = new AbortController();
    const response = await route(
      layer.id,
      "csv",
      "?__ui_prepare=1",
      controller.signal,
    );
    const { ticket } = (await response.json()) as { ticket: string };

    const firstStatus = await route(
      layer.id,
      "csv",
      `?__ui_status=${encodeURIComponent(ticket)}`,
    );
    expect(firstStatus.status).toBe(200);
    expect(await firstStatus.json()).toEqual({ status: "prepared" });

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterOldSignal = await route(
      layer.id,
      "csv",
      `?__ui_status=${encodeURIComponent(ticket)}`,
    );
    expect(afterOldSignal.status).toBe(200);
    expect(await afterOldSignal.json()).toEqual({ status: "prepared" });
    expect(await exportScratch()).toHaveLength(1);

    expect((await release(layer.id, ticket)).status).toBe(204);
    expect(await exportScratch()).toEqual([]);
  });

  it("creates no ticket when preparation starts already cancelled", async () => {
    const layer = await stored();
    const controller = new AbortController();
    controller.abort();

    const response = await route(
      layer.id,
      "csv",
      "?__ui_prepare=1",
      controller.signal,
    );

    expect(response.status).toBe(499);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await exportScratch()).toEqual([]);
  });

  it("propagates live preparation cancellation into the route's active exporter", async () => {
    const layer = await stored();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const layerExport = await import("./layer-export");
    vi.spyOn(layerExport, "exportLayerResult").mockImplementationOnce(
      async (_scope, _layer, _format, signal) => {
        receivedSignal = signal;
        // This controlled exporter isolates the route boundary. The sibling
        // unmocked export test holds production scratch reclamation itself;
        // this mock proves only signal propagation and response mapping.
        markStarted();
        return new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(new EvaluationCancelled());
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        });
      },
    );
    const controller = new AbortController();

    const preparing = route(
      layer.id,
      "csv",
      "?__ui_prepare=1",
      controller.signal,
    );
    await started;
    expect(receivedSignal?.aborted).toBe(false);

    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);

    const response = await preparing;
    expect(response.status).toBe(499);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("caller cancellation marks the stream failed and removes its real file", async () => {
    const layer = await stored();
    const ticket = await prepare(layer.id);
    const controller = new AbortController();
    const response = await route(
      layer.id,
      "csv",
      `?__ui_download=${encodeURIComponent(ticket)}`,
      controller.signal,
    );
    expect(response.status).toBe(200);

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    await vi.waitFor(async () => {
      const status = await route(
        layer.id,
        "csv",
        `?__ui_status=${encodeURIComponent(ticket)}`,
      );
      expect(await status.json()).toEqual({ status: "failed" });
      expect(await exportScratch()).toEqual([]);
    });
    expect((await release(layer.id, ticket)).status).toBe(204);
  });

  it("a browser body close before end is failed and cleaned", async () => {
    const layer = await stored();
    const ticket = await prepare(layer.id);
    const response = await route(
      layer.id,
      "csv",
      `?__ui_download=${encodeURIComponent(ticket)}`,
    );
    expect(response.status).toBe(200);

    await response.body!.cancel();
    await vi.waitFor(async () => {
      const status = await route(
        layer.id,
        "csv",
        `?__ui_status=${encodeURIComponent(ticket)}`,
      );
      expect(await status.json()).toEqual({ status: "failed" });
      expect(await exportScratch()).toEqual([]);
    });
    expect((await release(layer.id, ticket)).status).toBe(204);
  });

  it("explicit release removes an unclaimed preparation", async () => {
    const layer = await stored();
    const ticket = await prepare(layer.id);
    expect(await exportScratch()).toHaveLength(1);

    const response = await release(layer.id, ticket);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await exportScratch()).toEqual([]);

    const status = await route(
      layer.id,
      "csv",
      `?__ui_status=${encodeURIComponent(ticket)}`,
    );
    expect(status.status).toBe(400);
  });

  it("refuses conflicting private modes with the existing code", async () => {
    const layer = await stored();
    const response = await route(
      layer.id,
      "csv",
      "?__ui_prepare=1&__ui_status=anything",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as unknown).toEqual({
      error: {
        code: "invalid_request",
        message: "Conflicting private download markers.",
      },
    });
    expect(await exportScratch()).toEqual([]);
  });

  it("never turns a hostile ticket into a path or raw detail", async () => {
    const layer = await stored();
    const response = await route(
      layer.id,
      "csv",
      `?__ui_download=${encodeURIComponent("../../ids.env")}`,
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("ids.env");
    expect(text).not.toContain(process.cwd());
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "invalid_request",
        message: "This prepared download is no longer available.",
      },
    });
    expect(await exportScratch()).toEqual([]);
  });
});

describe("query result export", () => {
  it("CSV carries every row of a spatial result with geometry as WKT", async () => {
    const file = await exportQueryResult(
      testAccountScope(), "SELECT name, riders, geometry FROM stations ORDER BY name",
      "csv",
    );
    const text = await readFile(file.path, "utf8");
    const [header, ...rows] = text.trim().split("\n");
    expect(header).toBe("name,riders,geometry");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^alexanderplatz,900,POINT \(/);
    await file.cleanup();
  });

  it("CSV and parquet export a non-spatial result; GeoJSON refuses it with a reason", async () => {
    const csv = await exportQueryResult(
      testAccountScope(), "SELECT category, count(*) AS n FROM stations GROUP BY category ORDER BY category",
      "csv",
    );
    expect((await readFile(csv.path, "utf8")).trim().split("\n")).toEqual([
      "category,n",
      "s,2",
      "u,2",
    ]);
    await csv.cleanup();
    const parquet = await exportQueryResult(
      testAccountScope(), "SELECT category, count(*) AS n FROM stations GROUP BY category",
      "geoparquet",
    );
    const reopened = await withConnection(async (conn) => {
      const r = await conn.runAndReadAll(
        `SELECT count(*) AS n FROM read_parquet('${parquet.path.replace(/'/g, "''")}')`,
      );
      return Number(r.getRowObjects()[0].n);
    });
    expect(reopened).toBe(2);
    await parquet.cleanup();
    await expect(
      exportQueryResult(testAccountScope(), "SELECT category FROM stations", "geojson"),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/GeoJSON needs a geometry column/),
    });
  });

  it("GeoJSON keeps a row whose feature geometry is NULL", async () => {
    const file = await exportQueryResult(
      testAccountScope(), "SELECT name, CASE WHEN name = 'zoo' THEN NULL ELSE geometry END AS geometry FROM stations",
      "geojson",
    );
    const parsed = JSON.parse(await readFile(file.path, "utf8")) as {
      features: { properties: { name: string }; geometry: unknown }[];
    };
    expect(parsed.features).toHaveLength(4);
    const zoo = parsed.features.find((f) => f.properties.name === "zoo");
    expect(zoo?.geometry ?? null).toBeNull();
    await file.cleanup();
  });

  it("rejects a write statement at the guard and leaves no file", async () => {
    const before = await readdir(tileScratchDir());
    await expect(
      exportQueryResult(testAccountScope(), "CREATE TABLE x AS SELECT 1", "csv"),
    ).rejects.toMatchObject({ code: "sql_rejected" });
    expect(await readdir(tileScratchDir())).toEqual(before);
  });

  it("names the download after the caller's name", async () => {
    const file = await exportQueryResult(testAccountScope(), "SELECT 1 AS one", "csv", undefined, "My Result!");
    expect(file.filename).toBe("My Result.csv");
    await file.cleanup();
  });
});
