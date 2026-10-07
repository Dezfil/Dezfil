import { readThenWriteBrowserSetup } from "./edit-basis";
// Shared ground for the verification-depth suites: the house route policy
// (third-party hosts blocked, deterministic basemap-style stub on
// request), console tracking against the allowlist, API seeding for
// everything a suite is not itself testing, the disciplined map pixel
// shot (inset clip, floating chrome masked, change-detection only — never
// byte-exact across composited chrome), and the loopback fixture server
// the import suites read from.
import { expect } from "@playwright/test";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

export type ConsoleError = { text: string; url?: string };

/** Collect console + page errors; assert empty (minus the allowlist) at
 * the end of every suite. */
export function trackConsole(page: Page): ConsoleError[] {
  const errors: ConsoleError[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error")
      errors.push({ text: msg.text(), url: msg.location().url });
  });
  page.on("pageerror", (err) => errors.push({ text: String(err) }));
  return errors;
}

/** Consume the browser's expected console shadow of an injected fault:
 * one entry on the route, and with `message`, one whose words match it
 * too (a status, say), so a different failure on the same route stays. */
export async function consumeExpected(
  errors: ConsoleError[],
  route: RegExp,
  message?: RegExp,
): Promise<void> {
  const find = () =>
    errors.findIndex((entry) => route.test(entry.url ?? entry.text) && (!message || message.test(entry.text)));
  await expect.poll(find).toBeGreaterThanOrEqual(0);
  errors.splice(find(), 1);
}

/** A route that is exactly one address, nothing before or after it. */
export function exactly(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
}

/** House route policy: third-party hosts abort (the documented offline
 * environment); an optional handler runs first for local traffic and
 * returns true when it fulfilled/aborted the route itself. With
 * `basemapStyleStub`, the basemap style host answers a fixed empty style
 * (a deterministic local response, never the network) so maplibre reaches
 * "load" where a surface needs it. */
export async function routeHouse(
  context: BrowserContext,
  opts: {
    basemapStyleStub?: boolean;
    handler?: (route: Route) => Promise<boolean> | boolean;
  } = {},
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const url = route.request().url();
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      /* fall through to abort */
    }
    if (opts.basemapStyleStub && hostname === "tiles.openfreemap.org") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: 8, sources: {}, layers: [] }),
      });
    }
    if (!LOCAL_HOSTNAMES.has(hostname)) return route.abort();
    if (opts.handler && (await opts.handler(route))) return;
    return route.continue();
  });
}

export const mapIdOf = (page: Page) =>
  new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;

/** Settled means the transient "Saving…" indication is gone (it lives on
 * the stage's own chip, not in the header card).
 *
 * This is a SETTLE check and nothing more: it passes immediately when no
 * whisper is on screen — including the window before a just-triggered
 * write has rendered one. It therefore never proves that a write started
 * or landed. Every drive that TRIGGERS a write and
 * then asserts durable truth (or publishes) must arm an arrival signal
 * before the action — `layerSaveArrived` / `mapSaveArrived` below — and
 * await it, then settle. Bare `saveSettled` is for the read-only case:
 * nothing of ours is in flight (after a page load, or after an
 * already-awaited API-side seed). */
export const saveSettled = (page: Page) =>
  expect(page.getByText("Saving…", { exact: true })).toBeHidden();

/** Arrival signal for a layer write — armed BEFORE the triggering action
 * (never assert the transient whisper itself). */
export const layerSaveArrived = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/api\/layers\/[^/]+$/.test(response.url()),
  );

/** Arrival signal for a map-lane write — armed BEFORE the triggering
 * action, same institution as `layerSaveArrived`. */
export const mapSaveArrived = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/api\/maps\/[^/]+$/.test(response.url()),
  );

// ---- API seeding (browser-context fetches, same origin as the app) ----

/** Upload an in-memory CSV through the documented upload API. */
export async function seedCsv(
  page: Page,
  name: string,
  csv: string,
): Promise<{ name: string }> {
  return page.evaluate(
    async ({ name, csv }) => {
      const fd = new FormData();
      fd.append("file", new File([csv], `${name}.csv`, { type: "text/csv" }));
      const r = await fetch("/api/tables", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as { name: string };
    },
    { name, csv },
  );
}

/** Upload arbitrary in-memory file bytes through the upload API. */
export async function seedFile(
  page: Page,
  filename: string,
  bytes: Buffer | string,
  mimeType: string,
): Promise<{ name: string }> {
  const b64 = Buffer.isBuffer(bytes)
    ? bytes.toString("base64")
    : Buffer.from(bytes).toString("base64");
  return page.evaluate(
    async ({ filename, b64, mimeType }) => {
      const raw = atob(b64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
      const fd = new FormData();
      fd.append("file", new File([arr], filename, { type: mimeType }));
      const r = await fetch("/api/tables", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as { name: string };
    },
    { filename, b64, mimeType },
  );
}

export async function createMap(page: Page, name: string): Promise<string> {
  return page.evaluate(async (name) => {
    const r = await fetch("/api/maps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(await r.text());
    return ((await r.json()) as { id: string }).id;
  }, name);
}

/** Named read-then-write setup. Staleness probes use edit-basis.ts directly. */
export async function addLayer(page: Page, mapId: string, name: string, sql: string): Promise<string> {
  const result = await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({
    method: "POST", path: `/api/maps/${mapId}/layers`, body: { name, sql },
  }));
  if (result.status !== 201) throw new Error(JSON.stringify(result.json));
  return result.json.id as string;
}

/** New setup intent only; use a separately captured basis for stale probes. */
export async function patchLayer(page: Page, id: string, body: Record<string, unknown>): Promise<void> {
  const result = await readThenWriteBrowserSetup(page, `/api/layers/${id}`, () => ({ method: "PATCH", path: `/api/layers/${id}`, body }));
  if (result.status !== 200) throw new Error(JSON.stringify(result.json));
}

/** New setup intent only; use a separately captured basis for stale probes. */
export async function patchMap(page: Page, id: string, body: Record<string, unknown>): Promise<void> {
  const result = await readThenWriteBrowserSetup(page, `/api/maps/${id}`, () => ({ method: "PATCH", path: `/api/maps/${id}`, body }));
  if (result.status !== 200) throw new Error(JSON.stringify(result.json));
}

export async function publishMap(page: Page, mapId: string): Promise<string> {
  const result = await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/publish` }));
  if (result.status !== 201) throw new Error(JSON.stringify(result.json));
  return result.json.token as string;
}

export async function readLayer<T = Record<string, unknown>>(
  page: Page,
  id: string,
): Promise<T> {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/layers/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as never;
  }, id) as Promise<T>;
}

export async function readPublished<T = Record<string, unknown>>(
  page: Page,
  token: string,
): Promise<T> {
  return page.evaluate(async (token) => {
    const r = await fetch(`/api/published/${token}`, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as never;
  }, token) as Promise<T>;
}

// ---- map pixels, discipline ----

/** Inset past the map card's 22px corner radius: the clipped-corner
 * antialiasing is not byte-stable across separately composited frames. */
export const MAP_SHOT_INSET = 24;

/** The stylesheet every map shot applies while the shutter is open.
 *
 * Moved the builder's transient save status out of the header and onto the
 * map stage, inside `.canvasCol` — inside the region these shots clip —
 * where it fades for 430 ms after every save. A byte-exact comparison
 * across that window therefore reads the chip's ghost as a map change: on
 * the journey's post-undo shot the differing region was exactly the chip's
 * box, 32 pixels of 498,480 at a maximum per-channel delta of 1, with the
 * other 498,448 byte-identical.
 *
 * Masking cannot hold it, and that was measured rather than assumed:
 * Playwright paints a mask at the element's bounding box, and the corner's
 * box is 750x0 with the chip down and 750x30 with it up, so the mask
 * rectangle is itself the unstable thing. A screenshot-scoped stylesheet
 * has no box. It lasts only for the shot, needs no cleanup, and cannot
 * leak into the page the test then drives.
 *
 * It weakens nothing these shots assert. No map-pixel poll ever claimed
 * anything about the chip; its own placement, text, tone, hold and action
 * are owned by e2e/save-status-chip.spec.ts and watched by workflow-undo,
 * workflow-editing and workflow-runs. e2e/map-shot-chip.spec.ts is the
 * ratchet: it proves the chip really does move pixels inside this clip,
 * and that this line is what holds it out.
 */
export const MAP_SHOT_STYLE =
  "[data-save-status-corner] { display: none !important; }";

/** A shot of the rendered map only: the card window inset past its corner
 * radius, every floating chrome element masked. Used for CHANGE detection
 * against a settled base — never for byte-exact equality across chrome. */
export async function mapShot(page: Page): Promise<Buffer> {
  const box = await page.locator('[class*="canvasCol"]').boundingBox();
  if (!box) throw new Error("map card not on screen");
  return page.screenshot({
    style: MAP_SHOT_STYLE,
    clip: {
      x: box.x + MAP_SHOT_INSET,
      y: box.y + MAP_SHOT_INSET,
      width: box.width - MAP_SHOT_INSET * 2,
      height: box.height - MAP_SHOT_INSET * 2,
    },
    mask: [
      page.locator('[class*="StatusBar-module"]'),
      page.locator('[class*="timelineDock"]'),
      page.locator('[class*="stageStack"]'),
      page.locator('[class*="overlayCorner"]'),
      page.locator('[class*="offline"]'),
      page.locator('[class*="BasemapCredit-module"]'),
    ],
  });
}

/** Poll until the rendered map differs from a settled base shot. */
export async function expectMapChanged(
  page: Page,
  base: Buffer,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(async () => !(await mapShot(page)).equals(base), { timeout })
    .toBe(true);
}

// ---- loopback fixture server (import suites) ----

export const FIXTURES_DIR = path.join(__dirname, "fixtures");

// ---- Overture S3 fixture (the DEZFIL_OVERTURE_S3_ENDPOINT seam) ----

// Deliberately ABSENT from releases.ts's FALLBACK_RELEASES: if the
// listing seam were broken, listOvertureReleases() would fall back and
// the picker assertion would pass on a release this fixture never
// served — the value must be provable as really listed.
export const OVERTURE_FIXTURE_RELEASE = "2026-07-15.0";

/** An anonymous, path-style, S3-compatible read-only server holding one
 * Overture release with two minted parquets (buildings + divisions), so
 * the app's REAL Overture road — httpfs, glob expansion via
 * ListObjectsV2, ranged parquet reads, COPY, register — runs against a
 * loopback fixture. Objects are minted by DuckDB spatial at startup
 * (repo convention: no committed binaries). */
export async function startOvertureS3Fixture(port: number): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const { mkdtemp, rm: rmDir } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ovt-s3-"));
  const rel = OVERTURE_FIXTURE_RELEASE;
  const { DuckDBInstance } = await import("@duckdb/node-api");
  // Honor the preinstalled extension bundle (same convention as the
  // PostGIS seeder): with DUCKDB_EXTENSION_DIR set, INSTALL resolves
  // locally instead of fetching mid-suite.
  const mintConfig: Record<string, string> = {};
  if (process.env.DUCKDB_EXTENSION_DIR) {
    mintConfig.extension_directory = process.env.DUCKDB_EXTENSION_DIR;
  }
  const instance = await DuckDBInstance.create(":memory:", mintConfig);
  const conn = await instance.connect();
  await conn.run("INSTALL spatial; LOAD spatial;");
  const q = (s: string) => s.replace(/'/g, "''");
  const buildings = path.join(dir, "buildings.parquet");
  const divisions = path.join(dir, "divisions.parquet");
  // Buildings: four small polygons near Berlin, bbox struct mirroring each
  // geometry's extent (the import's WHERE prefilter reads bbox.*).
  await conn.run(`COPY (
    SELECT * FROM (VALUES
      ('b1', {'primary': 'Halle A', 'common': MAP{'en': 'Halle A'}},
       {'xmin': 13.401, 'ymin': 52.501, 'xmax': 13.402, 'ymax': 52.502},
       ST_GeomFromText('POLYGON((13.401 52.501, 13.402 52.501, 13.402 52.502, 13.401 52.502, 13.401 52.501))')),
      ('b2', {'primary': 'Halle B', 'common': MAP{'en': 'Halle B'}},
       {'xmin': 13.411, 'ymin': 52.511, 'xmax': 13.412, 'ymax': 52.512},
       ST_GeomFromText('POLYGON((13.411 52.511, 13.412 52.511, 13.412 52.512, 13.411 52.512, 13.411 52.511))')),
      ('b3', {'primary': 'Halle C', 'common': MAP{'en': 'Halle C'}},
       {'xmin': 13.421, 'ymin': 52.521, 'xmax': 13.422, 'ymax': 52.522},
       ST_GeomFromText('POLYGON((13.421 52.521, 13.422 52.521, 13.422 52.522, 13.421 52.522, 13.421 52.521))')),
      ('b4', {'primary': 'Halle D', 'common': MAP{'en': 'Halle D'}},
       {'xmin': 13.431, 'ymin': 52.531, 'xmax': 13.432, 'ymax': 52.532},
       ST_GeomFromText('POLYGON((13.431 52.531, 13.432 52.531, 13.432 52.532, 13.431 52.532, 13.431 52.531))'))
    ) AS t(id, names, bbox, geometry)
  ) TO '${q(buildings)}' (FORMAT PARQUET)`);
  // Divisions: one country row (the pane's countries list groups on
  // subtype='country'; LAND filter is coalesce(class,'land')='land').
  await conn.run(`COPY (
    SELECT * FROM (VALUES
      ('d1', 'DE', NULL, 'country', 'land',
       {'primary': 'Deutschland', 'common': MAP{'en': 'Germany'}},
       {'xmin': 5.9, 'ymin': 47.3, 'xmax': 15.0, 'ymax': 55.1},
       ST_GeomFromText('POLYGON((5.9 47.3, 15.0 47.3, 15.0 55.1, 5.9 55.1, 5.9 47.3))'))
    ) AS t(division_id, country, region, subtype, class, names, bbox, geometry)
  ) TO '${q(divisions)}' (FORMAT PARQUET)`);
  conn.closeSync();
  const objects: Record<string, string> = {
    [`release/${rel}/theme=buildings/type=building/part-0.parquet`]: buildings,
    [`release/${rel}/theme=divisions/type=division_area/part-0.parquet`]:
      divisions,
  };
  const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const bucketPrefix = "/overturemaps-us-west-2/";
      if (!url.pathname.startsWith(bucketPrefix.slice(0, -1))) {
        res.writeHead(404).end("wrong bucket");
        return;
      }
      const key = decodeURIComponent(
        url.pathname.slice(bucketPrefix.length),
      );
      if (url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        let inner = "";
        if (delimiter === "/" && prefix === "release/") {
          inner = `<CommonPrefixes><Prefix>release/${rel}/</Prefix></CommonPrefixes>`;
        } else {
          const { statSync } = await import("node:fs");
          inner = Object.entries(objects)
            .filter(([k]) => k.startsWith(prefix))
            .map(
              ([k, file]) =>
                `<Contents><Key>${xmlEscape(k)}</Key><Size>${statSync(file).size}</Size><ETag>"f"</ETag><LastModified>2026-06-17T00:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>`,
            )
            .join("");
        }
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>overturemaps-us-west-2</Name><Prefix>${xmlEscape(url.searchParams.get("prefix") ?? "")}</Prefix><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated>${inner}</ListBucketResult>`,
        );
        return;
      }
      const file = objects[key];
      if (!file) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Key>${xmlEscape(key)}</Key></Error>`,
        );
        return;
      }
      const body = await readFile(file);
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-length": body.length,
          "accept-ranges": "bytes",
          "content-type": "application/octet-stream",
        });
        res.end();
        return;
      }
      const range = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        res.writeHead(206, {
          "content-range": `bytes ${start}-${end}/${body.length}`,
          "content-length": end - start + 1,
          "accept-ranges": "bytes",
          "content-type": "application/octet-stream",
        });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, {
        "content-length": body.length,
        "accept-ranges": "bytes",
        "content-type": "application/octet-stream",
      });
      res.end(body);
    })().catch(() => {
      res.writeHead(500).end("overture fixture error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          void rmDir(dir, { recursive: true, force: true }).finally(resolve);
        });
      }),
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".geojson": "application/geo+json",
  ".json": "application/json",
  ".csv": "text/csv",
  ".parquet": "application/octet-stream",
};

/** Serve e2e/fixtures/* at /files/<name>, and a recorded-shape Overpass
 * response at /overpass (any method). Bound to 127.0.0.1 only.
 *
 * `failOverpass(status)` makes the seam answer that status instead — the
 * app's own Overpass client and error road then run for real against a
 * real upstream failure, at exactly the depth the success drive uses.
 * `failOverpass(null)` restores the recorded payload. */
export async function startFixtureServer(
  port: number,
  overrides: { files?: Record<string, Buffer> } = {},
): Promise<{
  origin: string;
  close: () => Promise<void>;
  server: Server;
  failOverpass: (status: number | null) => void;
}> {
  let overpassStatus: number | null = null;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname === "/overpass") {
        if (overpassStatus !== null) {
          res.writeHead(overpassStatus, { "content-type": "text/plain" });
          res.end("overpass unavailable");
          return;
        }
        const body = await readFile(path.join(FIXTURES_DIR, "overpass.json"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      const match = /^\/files\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
      if (!match) {
        res.writeHead(404).end("not found");
        return;
      }
      const name = match[1];
      const body =
        overrides.files?.[name] ??
        (await readFile(path.join(FIXTURES_DIR, name)).catch(() => null));
      if (!body) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type":
          CONTENT_TYPES[path.extname(name)] ?? "application/octet-stream",
      });
      res.end(body);
    })().catch(() => {
      res.writeHead(500).end("fixture server error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
    failOverpass: (status: number | null) => {
      overpassStatus = status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// Diagnostics ----

/** Name the failed stage when the published tilt control does not appear
 * (an intermittent with an unknown cause): whether the viewer reached
 * its ok-state, what the tilt-family button is actually named, the
 * authored camera the payload restores, and any failed layers. Logged
 * on timeout so the next firing is diagnostic instead of a bare 15 s
 * timeout. */
export async function tiltDiagnostic(
  page: Page,
  consoleErrors: { text: string; url?: string }[],
): Promise<string> {
  const token = new URL(page.url()).pathname.split("/")[2] ?? "";
  const tiltFamily = await page
    .getByRole("button", { name: /Tilt the map|Back to flat/ })
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  const diag = {
    stage:
      (await page.locator(".maplibregl-canvas").count()) === 0
        ? "viewer never reached ok-state (no canvas)"
        : tiltFamily.length === 0
          ? "ok-state but no tilt-family control rendered"
          : `control present, named ${JSON.stringify(tiltFamily)}`,
    couldNotLoad: await page.getByText("The map could not load.").count(),
    failedLayerRetries: await page.locator("[data-layer-retry]").count(),
    payload: await page
      .evaluate(async (t) => {
        const r = await fetch(`/api/published/${t}`, { cache: "no-store" });
        if (!r.ok) return `payload fetch ${r.status}`;
        const v = (await r.json()) as {
          viewport?: { pitch?: number };
          layers?: { render: { ok: boolean } }[];
        };
        return {
          pitch: v.viewport?.pitch ?? 0,
          failedRenders: (v.layers ?? []).filter((l) => !l.render.ok).length,
        };
      }, token)
      .catch((e) => `payload probe failed: ${String(e)}`),
    consoleErrors: consoleErrors.slice(-10),
  };
  return `settle diagnostic: ${JSON.stringify(diag)}`;
}
