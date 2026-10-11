import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { buildTemplate, installFixture, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import * as shippedIndex from "./shipped-index";
import { templateContents } from "./view";

/**
 * What a template version holds as its read answers it and its page opens
 * it, read from the installed folder as the map's reads find it: the map's
 * id, the datasets with what was measured of them, and a workflow
 * example's steps, each with its bundled result as the output, and its
 * arrangement. A version that is not installed holds nothing to read.
 * Reading writes nothing.
 */

const T0 = "2026-01-05T10:00:00.000Z";

let built: string;
let M1: BuiltTemplate, W1: BuiltTemplate, W2: BuiltTemplate, W3: BuiltTemplate;
let dir: string;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-view-"));
  M1 = await buildTemplate(path.join(built, "m1"), { id: "harbour-stations" });
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations" });
  // The arrangement written before the export keeps its own time.
  W2 = await buildTemplate(path.join(built, "w2"), {
    kind: "workflow", id: "kept-arrangement",
    edit: (files) => {
      const layout = files.documents.get("workflows/workflow.json")!.layout as Record<string, unknown>;
      layout.updatedAt = "2026-01-04T09:00:00.000Z";
    },
  });
  // Nothing placed and never written: the canvas arranges it.
  W3 = await buildTemplate(path.join(built, "w3"), {
    kind: "workflow", id: "unarranged",
    edit: (files) => {
      files.documents.get("workflows/workflow.json")!.layout = {
        editRevision: "r1", lastChangedAt: null, lastChangedBy: null, updatedAt: null, steps: {}, sources: {}, notes: [],
      };
    },
  });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-view-run-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), [M1]));
  const downloads = path.join(dir, "data", "templates");
  const origin = { kind: "catalogue", origin: "https://catalogue.example" } as const;
  for (const t of [W1, W2, W3]) await installFixture(t, path.join(downloads, t.facts.id, "1"), origin);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort();
}

describe("a template opened", () => {
  it("opens a shipped map template on its map's id, with its measured datasets and no workflow", () => {
    const opened = templateContents("harbour-stations", 1)!;
    expect(opened).toMatchObject({ mapId: "template.harbour-stations.1.map", createdAt: T0, updatedAt: T0, workflow: null });
    expect(opened.revision).toBe(M1.sha256.slice(0, 32));
    expect(opened.datasets.map(({ name, rowCount, geometryColumn, geometryType }) => ({ name, rowCount, geometryColumn, geometryType })))
      .toEqual([
        { name: "stations", rowCount: 6, geometryColumn: "geom", geometryType: "POINT" },
        { name: "districts", rowCount: 2, geometryColumn: "geom", geometryType: "POLYGON" },
      ]);
  });

  it("opens a workflow example's steps with their bundled results as outputs, and its arrangement", () => {
    const opened = templateContents("busy-stations", 1)!;
    expect(opened.mapId).toBe("template.busy-stations.1.map");
    const workflow = opened.workflow!;
    expect(workflow.name).toBe("Busy stations");
    expect(workflow.steps.map(({ id, operation, parameters, reads, output }) => ({
      id, operation, parameters, reads, output: { name: output.name, rowCount: output.rowCount, geometryType: output.geometryType },
    }))).toEqual([
      { id: "step-busy", operation: "sql_step", parameters: { sql: "SELECT * FROM stations WHERE riders > 100", name: "busy_stations" },
        reads: ["stations"], output: { name: "busy_stations", rowCount: 4, geometryType: "POINT" } },
      { id: "step-rings", operation: "buffer", parameters: { input: "busy_stations", distance: 250, name: "station_rings" },
        reads: ["busy_stations"], output: { name: "station_rings", rowCount: 4, geometryType: "POLYGON" } },
    ]);
    // Never written before the export, but placed: drawn where it was placed.
    expect(workflow.layout).toMatchObject({
      steps: { "step-busy": { x: 320, y: 40 }, "step-rings": { x: 620, y: 40 } },
      sources: { stations: { x: 20, y: 40 } },
      updatedAt: T0,
    });
    expect(workflow.layout.notes.map((n) => n.text)).toEqual(["Busy means more than a hundred riders."]);
  });

  it("keeps an arrangement's own time, and leaves one with nothing placed for the canvas to arrange", () => {
    expect(templateContents("kept-arrangement", 1)!.workflow!.layout.updatedAt).toBe("2026-01-04T09:00:00.000Z");
    expect(templateContents("unarranged", 1)!.workflow!.layout).toMatchObject({ steps: {}, sources: {}, notes: [], updatedAt: null });
  });

  it("hands each open its own copy", () => {
    const first = templateContents("busy-stations", 1)!;
    first.workflow!.steps[0].parameters.sql = "SELECT 1";
    first.workflow!.layout.steps["step-busy"].x = 0;
    const second = templateContents("busy-stations", 1)!;
    expect(second.workflow!.steps[0].parameters.sql).toBe("SELECT * FROM stations WHERE riders > 100");
    expect(second.workflow!.layout.steps["step-busy"].x).toBe(320);
  });

  it("opens nothing for a version not installed, an unknown id, or a shipped id at another version", () => {
    expect(templateContents("busy-stations", 2)).toBeNull();
    expect(templateContents("no-such-template", 1)).toBeNull();
    expect(templateContents("harbour-stations", 2)).toBeNull();
  });

  it("writes nothing", async () => {
    const before = await filesUnder(dir);
    templateContents("harbour-stations", 1);
    templateContents("busy-stations", 1);
    expect(await filesUnder(dir)).toEqual(before);
  });
});
