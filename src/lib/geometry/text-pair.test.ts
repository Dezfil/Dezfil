import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { inspectTable } from "@/lib/table-service";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { lit } from "@/lib/ingest/sql";
import { inspectGeometry, previewGeometry, setGeometry } from "./service";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";

const csv = 'x,y,payload\n10,20,"POINT (1 2)"\nbroken,40,"POINT (1 2)"\n" ",50,"POINT (1 2)"\n,60,"POINT (1 2)"\n70,,"POINT (1 2)"\n11,21,"POINT (1 2)"\n';
const choice = { format: "pair", columns: ["x", "y"] } as const;
let dir: string, remote: string;
vi.mock("@/lib/net/remote-fetch", () => ({ openRemote: vi.fn(async () => {
  const { Readable } = await import("node:stream");
  return { statusCode: 200, headers: { "content-type": "text/csv" }, body: Readable.from([remote]) };
}) }));
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { await cleanupGeometryTest(dir); });
async function fixture() {
  const file = path.join(dir, "text-pair.csv");
  await writeFile(file, csv);
  const table = await stored(`SELECT * FROM read_csv(${lit(file)})`);
  expect((await inspectGeometry(table.name)).columns).toContainEqual({ name: "x", type: "VARCHAR" });
  return table;
}
it("first preview accepts a text-typed pair with bad, whitespace and missing members", async () => {
  const t = await fixture();
  const p = await previewGeometry(t.name, (await inspectGeometry(t.name)).revision, choice);
  expect(p).toMatchObject({ canApply: true, rowCount: 6, unreadableCount: 2, extent: [10, 20, 11, 21] });
  expect(p.sample.rows.map(r => r.status)).toEqual(["readable", "unreadable", "unreadable", "missing", "missing", "readable"]);
  expect(p.sample.features.features.map(f => f.geometry)).toEqual([
    { type: "Point", coordinates: [10, 20] }, null, null, null, null, { type: "Point", coordinates: [11, 21] },
  ]);
  expect(p.sample.rows.map(r => r.values.x)).toEqual(["10", "broken", " ", null, "70", "11"]);
});
it.each(["first set", "change"])("%s accepts a text-typed pair and retains its source values", async mode => {
  const t = await fixture();
  const before = await inspectTable(t.name);
  if (mode === "change") await setGeometry(t.name, (await inspectGeometry(t.name)).revision, { format: "wkt", columns: ["payload"] });
  const result = await setGeometry(t.name, (await inspectGeometry(t.name)).revision, choice);
  expect(result).toMatchObject({ extent: [10, 20, 11, 21], table: { rowCount: 6, geometryRecord: { unreadableCount: 2 } } });
  const after = await inspectTable(t.name);
  expect(after.preview.map(r => r[result.table.geometryColumn!])).toEqual(["POINT (10 20)", null, null, null, null, "POINT (11 21)"]);
  for (let i = 0; i < before.preview.length; i++) expect(after.preview[i]).toMatchObject(before.preview[i]);
  const swapped = await setGeometry(t.name, result.revision, { format: "pair", columns: ["y", "x"] });
  expect(swapped).toMatchObject({ extent: [20, 10, 21, 11], table: { geometryRecord: { unreadableCount: 2 } } });
});
it("a pair selected as text on first use replays fresh text after restart", async () => {
  remote = csv;
  const t = (await importFromUrl("https://fixture.test/text-pair.csv")).tables[0];
  await setGeometry(t.name, (await inspectGeometry(t.name)).revision, choice);
  closeMetadataDb();
  remote = 'x,y\n30,40\nbroken,50\n" ",60\n,70\n80,\n';
  const next = await refreshTable(t.name);
  expect(next).toMatchObject({ rowCount: 5, geometryRecord: { signal: "manual", unreadableCount: 2 } });
  const after = await inspectTable(t.name);
  expect(after.preview.map(r => r[next.geometryColumn!])).toEqual(["POINT (30 40)", null, null, null, null]);
  expect(after.preview.map(r => r.x)).toEqual(["30", "broken", " ", null, "80"]);
  expect(await inspectGeometry(t.name)).toMatchObject({ mode: "set", currentChoice: choice });
});
