import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withConnection } from "@/lib/duckdb";
import { closeMetadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";
import { testAccountScope } from "@/lib/test-support/accounts";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { buildGpkg } from "../../../test-support/gpkg";
import { importFromUrl } from "./remote";

/**
 * The credentialed object road end to end: the engine downloads a file it
 * cannot read in place and the import lands it as a table. One loopback
 * store stands in for both addresses the road asks, the S3 address in
 * effect (the size probe) and the engine's own (the download), so nothing
 * here leaves this machine. The engine never installs an extension here,
 * so the instance's credential chain is never set up and the store is read
 * without credentials.
 */

keepRequestsOnThisMachine();

const root = process.env.DEZFIL_DATA_DIR!;
const POINTS = JSON.stringify({
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "alpha" }, geometry: { type: "Point", coordinates: [13.4, 52.5] } },
    { type: "Feature", properties: { name: "beta" }, geometry: { type: "Point", coordinates: [2.35, 48.85] } },
  ],
});

const objects = new Map<string, Buffer>();
let asked: string[];
let store: Server;
let origin: string;

/** A store answering HEAD, GET and ranged GET for the objects it holds. */
function answer(req: IncomingMessage, res: ServerResponse) {
  asked.push(`${req.method} ${req.url}`);
  const body = objects.get(req.url ?? "");
  if (!body) {
    res.writeHead(404);
    res.end();
    return;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  res.writeHead(range ? 206 : 200, {
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    "last-modified": new Date(0).toUTCString(),
    ...(range ? { "content-range": `bytes ${start}-${end}/${body.length}` } : {}),
  });
  res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1));
}

beforeAll(async () => {
  store = createServer(answer);
  await new Promise<void>((resolve) => store.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  objects.set("/bucket/points.geojson", Buffer.from(POINTS));
  const gpkg = path.join(mkdtempSync(path.join(root, "credentialed-import-")), "harbours.gpkg");
  buildGpkg(gpkg, [{ name: "harbours", kind: "points", rows: [[7.1, 51.1, "alpha"], [7.2, 51.2, "beta"], [7.3, 51.3, "gamma"]] }]);
  objects.set("/bucket/harbours.gpkg", readFileSync(gpkg));
});

afterAll(async () => {
  await new Promise<void>((resolve) => store.close(() => resolve()));
  await withConnection(async (conn) => {
    for (const setting of ["s3_endpoint", "s3_url_style", "s3_use_ssl", "autoinstall_known_extensions"]) {
      await conn.run(`RESET GLOBAL ${setting}`);
    }
  });
});

beforeEach(async () => {
  closeMetadataDb();
  asked = [];
  vi.stubEnv("DEZFIL_DATA_DIR", mkdtempSync(path.join(root, "credentialed-import-")));
  vi.stubEnv("DEZFIL_OBJECT_STORE_CREDENTIALS", "true");
  vi.stubEnv("DEZFIL_S3_ENDPOINT", origin);
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  // The engine's own S3 address is the loopback store, and it installs
  // nothing: the credential chain needs an extension this machine has not
  // installed, so setting it up fails quietly, as the road allows.
  const port = new URL(origin).port;
  const settings = await withConnection(async (conn) => {
    await conn.run("SET GLOBAL autoinstall_known_extensions = false");
    await conn.run(`SET GLOBAL s3_endpoint = '127.0.0.1:${port}'`);
    await conn.run("SET GLOBAL s3_url_style = 'path'");
    await conn.run("SET GLOBAL s3_use_ssl = false");
    const read = await conn.runAndReadAll(
      "SELECT current_setting('s3_endpoint') AS endpoint, current_setting('autoinstall_known_extensions') AS install",
    );
    return read.getRowObjects()[0];
  });
  expect(settings).toEqual({ endpoint: `127.0.0.1:${port}`, install: false });
});

afterEach(() => {
  closeMetadataDb();
  vi.unstubAllEnvs();
});

it.each([
  { object: "points.geojson", name: "points", format: "geojson", rows: 2 },
  { object: "harbours.gpkg", name: "harbours", format: "geopackage", rows: 3 },
])("lands a credentialed $format import as a table", async ({ object, name, format, rows }) => {
  const result = await importFromUrl(testAccountScope(), `s3://bucket/${object}`);
  expect(result.tables).toHaveLength(1);
  expect(result.tables[0]).toMatchObject({ name, format, rowCount: rows, geometryType: "POINT" });
  expect(listTables().map((table) => table.name)).toEqual([name]);
  // The size probe and the engine's download both reached the stand-in.
  expect(asked).toContain(`HEAD /bucket/${object}`);
  expect(asked.some((request) => request.startsWith(`GET /bucket/${object}`))).toBe(true);
  expect(asked.every((request) => request.endsWith(`/bucket/${object}`))).toBe(true);
});
