import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { extractArchive } from "@/lib/ingest/container";
import { testClient } from "@/lib/mcp/test-client";
import type { LayerViz } from "@/lib/viz";
import type { FillPaint, LayerStyle, QuantileFill } from "@/lib/style/style";
import { journeyClient } from "../../scripts/mcp-journey-core.mjs";

/**
 * Every road a stored paint travels keeps its whole-number fact as
 * stored: a duplicated layer and map, undo and redo in both directions, the
 * published view (a warm read after a change included), and a project
 * export's map document. The template copy is held beside its own fixture,
 * in the copy test. Each case stores facts that differ by location (true on
 * the fill, false on the outline and the cells), so a road that dropped the
 * field, or took it from another location, reads differently.
 */

let dir: string;
let client: Awaited<ReturnType<typeof testClient>>;
let journey: Awaited<ReturnType<typeof journeyClient>>;
const api = async (url: string) =>
  (await dispatchAssistantTestRoute(socketRequest(new Request(`http://localhost:3307${url}`)))).json();

beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-whole-copies-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
  client = await testClient(dispatchAssistantTestRoute);
  journey = await journeyClient(client, api);
});
afterAll(async () => {
  await client?.close();
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const SQL = `SELECT (i % 7 + i // 50)::INTEGER AS n,
  ST_Point(13 + (i % 20) * 0.02, 52 + (i // 20) * 0.02) AS geometry
  FROM range(0, 200) AS t(i)`;

interface Stored {
  id: string;
  mapId: string;
  name: string;
  editRevision: string;
  style: LayerStyle;
  viz: LayerViz;
}

const fact = (paint: FillPaint | undefined) =>
  paint && paint.type === "quantile" ? paint.wholeNumbers : "not classed";
const cellsFill = (viz: LayerViz) => (viz.type === "hexbin" || viz.type === "grid" ? viz.fill : undefined);
/** The three facts a layer stores, by location. */
const facts = (l: { style: LayerStyle; viz: LayerViz }) => ({
  fill: fact(l.style.fill),
  outline: fact(l.style.strokeBy),
  cells: fact(cellsFill(l.viz)),
});
const SEEDED = { fill: true, outline: false, cells: false };

/** A map with one layer whose fill, outline and cells each store a fact. */
async function seeded(projectId?: string): Promise<Stored> {
  const map = await journey.call("create_map", { name: "Counts", ...(projectId ? { projectId } : {}) });
  const created: Stored = await journey.call("create_layer", { id: map.id, name: "Counts", expected_revision: map.editRevision, sql: SQL });
  const paint: QuantileFill = await journey.call("compute_fill", { id: created.id, attribute: "n", method: "quantile" });
  const cells = { ...paint, attribute: "value", breaks: [1, 2, 3], colors: paint.colors.slice(0, 4), wholeNumbers: false };
  const style = { ...created.style, fill: { ...paint, wholeNumbers: true }, strokeBy: { ...paint, wholeNumbers: false } };
  await journey.call("update_layer", { id: created.id, expected_revision: created.editRevision, style });
  const styled: Stored = await journey.call("get_layer", { id: created.id });
  await journey.call("update_layer", {
    id: created.id, expected_revision: styled.editRevision,
    viz: { type: "hexbin", cellKm: 2, aggregate: { fn: "count" }, fill: cells },
    // Entering the cells clears the stored fill's fact; stating the style
    // again keeps the seeded one.
    style,
  });
  const layer: Stored = await journey.call("get_layer", { id: created.id });
  expect(facts(layer)).toEqual(SEEDED);
  return layer;
}

describe("the roads a stored paint travels", () => {
  it("a duplicated layer keeps each location's fact", async () => {
    const layer = await seeded();
    const map = await journey.call("get_map", { id: layer.mapId });
    const copy: Stored = await journey.call("duplicate_layer", { id: layer.id, expected_revision: map.editRevision });
    expect(copy.id).not.toBe(layer.id);
    expect(facts(await journey.call("get_layer", { id: copy.id }))).toEqual(SEEDED);
  });

  it("a duplicated map keeps each location's fact", async () => {
    const layer = await seeded();
    const copy = await journey.call("duplicate_map", { id: layer.mapId });
    expect(copy.id).not.toBe(layer.mapId);
    const read = await journey.call("get_map", { id: copy.id });
    expect(read.layers.map(facts)).toEqual([SEEDED]);
  });

  it("undo and redo restore the fact a write cleared, and the one a write stated", async () => {
    const layer = await seeded();
    const map = () => journey.call("get_map", { id: layer.mapId });
    const now = async () => facts(await journey.call("get_layer", { id: layer.id }));
    // A SQL change clears the fact from all three stored paints.
    await journey.call("update_layer", { id: layer.id, expected_revision: (await map()).editRevision, sql: SQL.replace("% 7", "% 5") });
    const cleared = { fill: undefined, outline: undefined, cells: undefined };
    expect(await now()).toEqual(cleared);
    await journey.call("undo_change", { id: layer.mapId, expected_revision: (await map()).editRevision });
    expect(await now()).toEqual(SEEDED);
    await journey.call("redo_change", { id: layer.mapId, expected_revision: (await map()).editRevision });
    expect(await now()).toEqual(cleared);
    await journey.call("undo_change", { id: layer.mapId, expected_revision: (await map()).editRevision });
    // A sent paint states its own fact; undo puts the stored one back.
    const stored: Stored = await journey.call("get_layer", { id: layer.id });
    const fill = { ...stored.style.fill, wholeNumbers: false } as FillPaint;
    await journey.call("update_layer", { id: layer.id, expected_revision: stored.editRevision, style: { ...stored.style, fill } });
    expect((await now()).fill).toBe(false);
    await journey.call("undo_change", { id: layer.mapId, expected_revision: (await map()).editRevision });
    expect(await now()).toEqual(SEEDED);
    await journey.call("redo_change", { id: layer.mapId, expected_revision: (await map()).editRevision });
    expect((await now()).fill).toBe(false);
  });

  it("the published view carries each fact, and a warm read after a change carries the change", async () => {
    const layer = await seeded();
    const { body } = await journey.gate("publish_map", { id: layer.mapId, expected_revision: (await journey.call("get_map", { id: layer.mapId })).editRevision }, true);
    const token = body.token as string;
    expect(token).toEqual(expect.any(String));
    const published = async () => {
      const view = await api(`/api/published/${token}`);
      return view.layers.map((l: { style: LayerStyle; viz: LayerViz }) => facts(l));
    };
    // A reader is served the cells' effective style: the cells' fill, no outline.
    const served = { fill: SEEDED.cells, outline: "not classed", cells: SEEDED.cells };
    expect(await published()).toEqual([served]);
    const current: Stored = await journey.call("get_layer", { id: layer.id });
    await journey.call("update_layer", { id: layer.id, expected_revision: current.editRevision, sql: SQL.replace("% 7", "% 3") });
    expect(await published()).toEqual([{ fill: undefined, outline: "not classed", cells: undefined }]);
  });

  it("a project export's map document keeps each location's fact", async () => {
    const project = await journey.call("create_project", { name: "Counts export" });
    const layer = await seeded(project.id);
    const exported = await journey.call("export_project", { id: project.id, maps: [layer.mapId], workflows: [], tables: [], file: "counts" });
    const zip = path.join(dir, "counts.zip");
    await writeFile(zip, Buffer.from(exported.attachment.content_base64, "base64"));
    const out = path.join(dir, "counts-extracted");
    await extractArchive(zip, out, "counts.zip");
    const files = (await readdir(out, { recursive: true })).map(String).filter((f) => /maps\/[^/]+\.json$/.test(f));
    expect(files).toHaveLength(1);
    const doc = JSON.parse(await readFile(path.join(out, files[0]), "utf8"));
    expect(doc.layers.map(facts)).toEqual([SEEDED]);
  });
});
