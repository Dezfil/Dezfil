import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { fileRecipe } from "@/lib/metadata/projects";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { dataDir } from "@/lib/config";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "./scope";

/**
 * A shared project's archive. Ada owns project P (Bob an editor, Vic a
 * viewer), her `roads`, a map and a workflow filed in it; Bob filed a `roads`
 * of his own there. Everyone who reaches P exports it; two people's `roads`
 * become two entries named as the exporter types them, the manifest says
 * whose each is, and the map and workflow documents carry their SQL home.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let ids: Record<string, string>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "project-export-sharing-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "vic", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const owner of ["ada", "bob"]) {
    const file = path.join(directory, `${owner}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} roads,1,2\n`);
    tables[owner] = await ingestFile(scopes[owner], file, "roads.csv");
  }
  shareProject("ada", "P", [["bob", "editor"], ["vic", "viewer"]], [tables.ada.id, tables.bob.id]);
  const map = createMap(scopes.ada, "Survey", "P");
  await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
  const recipe = createRecipe(scopes.ada, "Staging").id;
  fileRecipe(recipe, "P");
  addStep(recipe, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "staged" } });
  ids = { map: map.id, recipe };
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

async function exportAs(account: string, project: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/projects/[id]/export/route");
  const request = testAccountRequest(new Request(`http://instance.test/api/projects/${project}/export`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: "p", ...body }),
  }), undefined, account);
  const response = await POST(request, { params: Promise.resolve({ id: project }) });
  if (response.status !== 200) return { status: response.status, body: await response.json(), zip: null };
  return { status: 200, body: null, zip: await JSZip.loadAsync(Buffer.from(await response.arrayBuffer())) };
}
const everything = () => ({ maps: [ids.map], workflows: [ids.recipe], datasets: [tables.ada.id, tables.bob.id] });
const json = async (zip: JSZip, name: string) => JSON.parse(await zip.file(`p.dezfil/${name}`)!.async("string"));

describe("exporting a shared project", () => {
  it("is open to a viewer, with every dataset its own entry under the name the exporter types", async () => {
    const { status, zip } = await exportAs("vic", "P", everything());
    expect(status).toBe(200);
    expect(Object.keys(zip!.files).filter((name) => !name.endsWith("/")).sort()).toEqual([
      "p.dezfil/datasets/ada.roads.parquet", "p.dezfil/datasets/bob.roads.parquet",
      "p.dezfil/maps/survey.json", "p.dezfil/project.json", "p.dezfil/workflows/staging.json",
    ]);
    const manifest = await json(zip!, "project.json");
    expect(manifest.exportedBy).toEqual({ sqlName: "vic" });
    const byName = (a: unknown[], b: unknown[]) => String(a[1]).localeCompare(String(b[1]));
    expect(manifest.contents.datasets.map((d: Record<string, unknown>) => [d.id, d.qualifiedName, d.owner, d.file]).sort(byName)).toEqual([
      [tables.ada.id, "ada.roads", { name: "ada", sqlName: "ada" }, "datasets/ada.roads.parquet"],
      [tables.bob.id, "bob.roads", { name: "bob", sqlName: "bob" }, "datasets/bob.roads.parquet"],
    ]);
    for (const owner of ["ada", "bob"]) {
      const stored = await readFile(path.join(dataDir(), tables[owner].file));
      expect(Buffer.compare(await zip!.file(`p.dezfil/datasets/${owner}.roads.parquet`)!.async("nodebuffer"), stored)).toBe(0);
    }
    expect((await json(zip!, "maps/survey.json")).home).toBe("ada");
    expect((await json(zip!, "workflows/staging.json")).home).toBe("ada");
  });

  it("names the exporter's own dataset plainly and converts each by its identity", async () => {
    const own = await exportAs("ada", "P", { datasets: [tables.ada.id, tables.bob.id] });
    expect((await json(own.zip!, "project.json")).contents.datasets.map((d: { file: string }) => d.file).sort())
      .toEqual(["datasets/bob.roads.parquet", "datasets/roads.parquet"]);
    const converted = await exportAs("bob", "P", { datasets: [tables.ada.id, tables.bob.id], datasetFormat: "geojson" });
    expect(await converted.zip!.file("p.dezfil/datasets/ada.roads.geojson")!.async("string")).toContain("ada roads");
    const mine = await converted.zip!.file("p.dezfil/datasets/roads.geojson")!.async("string");
    expect(mine).toContain("bob roads");
    expect(mine).not.toContain("ada roads");
  });

  it("answers an outsider exactly as a project that never existed", async () => {
    const hidden = await exportAs("cyd", "P", everything());
    const never = await exportAs("cyd", "never-existed", everything());
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(never);
  });
});
