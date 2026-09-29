import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { GET, POST } from "./route";

/**
 * The query-result download's two roads: the direct attachment any caller
 * streams, and the page's prepared road — a single-use ticket redeemed as
 * a native attachment. Format refusal and the GeoJSON-needs-geometry rule
 * answer with coded errors on both.
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
    "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n",
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
});
afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown): Request {
  return new Request("http://test/api/query/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/query/export (direct)", () => {
  it("streams every row as a CSV attachment", async () => {
    const res = await POST(
      post({ sql: "SELECT name FROM stations ORDER BY name", format: "csv", name: "My rows" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="My rows.csv"');
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect((await res.text()).trim().split("\n")).toEqual(["name", "alexanderplatz", "zoo"]);
  });
  it("refuses an unknown format and GeoJSON without geometry, coded", async () => {
    const bad = await POST(post({ sql: "SELECT 1", format: "xlsx" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_request");
    const geo = await POST(post({ sql: "SELECT name FROM stations", format: "geojson" }));
    expect(geo.status).toBe(400);
    expect((await geo.json()).error.message).toMatch(/GeoJSON needs a geometry column/);
  });
});

describe("the prepared road", () => {
  it("prepares a single-use ticket that redeems once as a native attachment", async () => {
    const prep = await POST(
      post({ sql: "SELECT name FROM stations ORDER BY name", format: "csv", prepare: true }),
    );
    expect(prep.status).toBe(200);
    const { ticket, key, format } = (await prep.json()) as { ticket: string; key: string; format: string };
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const url = `http://test/api/query/export?ticket=${ticket}&key=${key}&format=${format}`;
    const first = await GET(new Request(url));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-disposition")).toBe('attachment; filename="query_result.csv"');
    expect((await first.text()).trim().split("\n")).toEqual(["name", "alexanderplatz", "zoo"]);
    const second = await GET(new Request(url));
    expect(second.status).toBe(410);
    expect((await second.json()).error.message).toMatch(/no longer available/);
  });
  it("a ticket bound to one SQL does not redeem under another key or format", async () => {
    const prep = await POST(post({ sql: "SELECT name FROM stations", format: "csv", prepare: true }));
    const { ticket, key } = (await prep.json()) as { ticket: string; key: string };
    const wrongKey = await GET(new Request(`http://test/api/query/export?ticket=${ticket}&key=${key}x&format=csv`));
    expect(wrongKey.status).toBe(410);
    const wrongFormat = await GET(new Request(`http://test/api/query/export?ticket=${ticket}&key=${key}&format=geojson`));
    expect(wrongFormat.status).toBe(410);
  });
});
