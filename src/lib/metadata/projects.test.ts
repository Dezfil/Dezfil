import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import { insertMap, getMap, type MapRecord } from "./maps";
import { createRecipe, getRecipe } from "./recipes";
import { insertTable, type DataTable } from "./tables";
import {
  changeMembers,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  mapProjectId,
  projectMemberCounts,
  projectMemberIds,
  tableProjectIds,
  touchProjectsOf,
  updateProject,
  PROJECT_NAME_MAX,
} from "./projects";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  db = open(path.join(dir, "metadata.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function seedMap(id: string, publishToken: string | null = null): MapRecord {
  const now = new Date().toISOString();
  const map: MapRecord = {
    id,
    name: `Map ${id}`,
    viewport: { lng: 13.4, lat: 52.5, zoom: 10 },
    basemap: null,
    customBasemap: null,
    basemapLayers: null,
    note: null,
    legendCorner: null,
    legendOrder: null,
    timeline: null,
    widgets: [],
    widgetsPublished: true,
    publishToken,
    publishedAt: publishToken ? now : null,
    published: publishToken !== null,
    createdAt: now,
    updatedAt: now,
  };
  insertMap(testAccountScope(db), map, db);
  return map;
}

function seedTable(id: string): DataTable {
  const now = new Date().toISOString();
  const table: DataTable = {
    id,
    name: `t_${id}`,
    sourceFilename: null,
    format: "geojson",
    file: `tables/${id}.parquet`,
    geometryColumn: "geometry",
    geometryType: "POINT",
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 3,
    createdAt: now,
    source: "upload",
    sourceParams: null,
    importedAt: null,
  };
  insertTable(testAccountScope(db), table, db);
  return table;
}

describe("project rows", () => {
  it("stores the trimmed name, allows duplicates, refuses blank and over-long", () => {
    const a = createProject(testAccountScope(db), { name: "  Berlin mobility study  " }, db);
    expect(a.name).toBe("Berlin mobility study");
    const b = createProject(testAccountScope(db), { name: "Berlin mobility study" }, db);
    expect(b.id).not.toBe(a.id);
    expect(() => createProject(testAccountScope(db), { name: "   " }, db)).toThrow(/non-empty/);
    expect(() =>
      createProject(testAccountScope(db), { name: "x".repeat(PROJECT_NAME_MAX + 1) }, db),
    ).toThrow(/at most/);
  });

  it("edits name and note, advancing updated_at; clearing the note stores null", () => {
    const p = createProject(testAccountScope(db), { name: "Study", note: "First pass" }, db);
    const renamed = updateProject(p.id, { name: "Flood atlas" }, db);
    expect(renamed.name).toBe("Flood atlas");
    expect(renamed.note).toBe("First pass");
    const cleared = updateProject(p.id, { note: null }, db);
    expect(cleared.note).toBeNull();
    expect(cleared.updatedAt > p.updatedAt).toBe(true);
    expect(() => updateProject("p-none", { name: "X" }, db)).toThrow(/No project/);
  });

  it("lists most recent first", () => {
    const a = createProject(testAccountScope(db), { name: "A" }, db);
    const b = createProject(testAccountScope(db), { name: "B" }, db);
    expect(listProjects(db).map((p) => p.id)).toEqual(
      [b.id, a.id].sort((x, y) => {
        const pa = getProject(x, db)!;
        const pb = getProject(y, db)!;
        return pb.createdAt.localeCompare(pa.createdAt) || pb.id.localeCompare(pa.id);
      }),
    );
  });

  it("creation with initial members is atomic: one unknown member leaves neither project nor membership", () => {
    seedMap("m1");
    const before = listProjects(db).length;
    expect(() =>
      createProject(
        testAccountScope(db),
        { name: "Doomed", members: { addMaps: ["m1"], addTables: ["t-none"] } },
        db,
      ),
    ).toThrow(expect.objectContaining({ code: "not_found", status: 404 }));
    expect(listProjects(db).length).toBe(before);
    expect(mapProjectId("m1", db)).toBeNull();
  });
});

describe("membership", () => {
  it("a mixed change applies together; a map filed elsewhere moves; datasets can be in two projects; re-adding is idempotent", () => {
    seedMap("m1");
    createRecipe(testAccountScope(db), "Catchments", db, "workflow");
    const r = db.prepare(`SELECT id FROM recipes`).get() as { id: string };
    seedTable("t1");
    const a = createProject(testAccountScope(db), { name: "A" }, db);
    const b = createProject(testAccountScope(db), { name: "B" }, db);

    changeMembers(a.id, { addMaps: ["m1"], addRecipes: [r.id], addTables: ["t1"] }, db);
    expect(mapProjectId("m1", db)).toBe(a.id);
    expect(getRecipe(r.id, db)?.projectId).toBe(a.id);
    expect(tableProjectIds(db).get("t1")).toEqual([a.id]);

    // The move: filing into B leaves A without the map, and the dataset
    // joins B while staying in A.
    changeMembers(b.id, { addMaps: ["m1"], addTables: ["t1"] }, db);
    expect(mapProjectId("m1", db)).toBe(b.id);
    expect(tableProjectIds(db).get("t1")?.slice().sort()).toEqual([a.id, b.id].sort());

    // Idempotent re-add changes nothing.
    changeMembers(b.id, { addTables: ["t1"] }, db);
    expect(tableProjectIds(db).get("t1")?.slice().sort()).toEqual([a.id, b.id].sort());

    // Removal from one project leaves the other.
    changeMembers(a.id, { removeTables: ["t1"] }, db);
    expect(tableProjectIds(db).get("t1")).toEqual([b.id]);
  });

  it("one unknown member in a mixed change leaves every membership unchanged", () => {
    seedMap("m1");
    seedTable("t1");
    const a = createProject(testAccountScope(db), { name: "A" }, db);
    changeMembers(a.id, { addTables: ["t1"] }, db);
    expect(() =>
      changeMembers(a.id, { addMaps: ["m1"], addTables: ["t-none"] }, db),
    ).toThrow(/No dataset/);
    expect(mapProjectId("m1", db)).toBeNull();
    expect(tableProjectIds(db).get("t1")).toEqual([a.id]);
  });

  it("filing never advances the member's own edited time; membership advances the project's, and a move touches both projects", () => {
    const m = seedMap("m1");
    const a = createProject(testAccountScope(db), { name: "A" }, db);
    const b = createProject(testAccountScope(db), { name: "B" }, db);
    changeMembers(a.id, { addMaps: ["m1"] }, db);
    expect(getMap("m1", db)?.updatedAt).toBe(m.updatedAt);
    const aAfterAdd = getProject(a.id, db)!;
    expect(aAfterAdd.updatedAt > a.updatedAt).toBe(true);
    changeMembers(b.id, { addMaps: ["m1"] }, db);
    const aAfterMove = getProject(a.id, db)!;
    const bAfterMove = getProject(b.id, db)!;
    expect(aAfterMove.updatedAt > aAfterAdd.updatedAt).toBe(true);
    expect(bAfterMove.updatedAt > b.updatedAt).toBe(true);
    expect(getMap("m1", db)?.updatedAt).toBe(m.updatedAt);
  });

  it("can remove a directly seeded builder-origin membership without changing the remaining workflow", () => {
    const project = createProject(testAccountScope(db), { name: "A" }, db);
    const workflow = createRecipe(testAccountScope(db), "Workflow", db, "workflow");
    const builder = createRecipe(testAccountScope(db), "Builder tool", db, "builder");
    db.prepare(`UPDATE recipes SET project_id = ? WHERE id IN (?, ?)`).run(
      project.id,
      workflow.id,
      builder.id,
    );
    const builderBefore = getRecipe(builder.id, db)!;

    changeMembers(project.id, { removeRecipes: [builder.id] }, db);

    expect(getRecipe(builder.id, db)).toEqual({
      ...builderBefore,
      projectId: null,
    });
    expect(getRecipe(workflow.id, db)?.projectId).toBe(project.id);
  });
});

describe("dissolution and member deletion", () => {
  it("deleting a project dissolves the set and deletes nothing", () => {
    seedMap("m1");
    seedTable("t1");
    const a = createProject(
      testAccountScope(db),
      { name: "A", members: { addMaps: ["m1"], addTables: ["t1"] } },
      db,
    );
    expect(deleteProject(a.id, db)).toBe(true);
    expect(getProject(a.id, db)).toBeNull();
    expect(getMap("m1", db)).not.toBeNull();
    expect(mapProjectId("m1", db)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM data_tables`).get()).toEqual({ n: 1 });
    expect(tableProjectIds(db).size).toBe(0);
  });

  it("deleting a member removes only its memberships, and the affected projects' clocks advance when told", () => {
    seedTable("t1");
    seedTable("t2");
    const a = createProject(testAccountScope(db), { name: "A", members: { addTables: ["t1", "t2"] } }, db);
    const before = getProject(a.id, db)!;
    touchProjectsOf({ tableId: "t1" }, db, "2027-01-01T00:00:00.000Z");
    db.prepare(`DELETE FROM data_tables WHERE id = 't1'`).run();
    expect(tableProjectIds(db).get("t2")).toEqual([a.id]);
    expect(tableProjectIds(db).get("t1")).toBeUndefined();
    expect(getProject(a.id, db)!.updatedAt > before.updatedAt).toBe(true);
  });
});

describe("member counts", () => {
  it("counts maps, published maps, workflows and datasets per project; a shared dataset counts once in each", () => {
    seedMap("m1", "tok-1");
    seedMap("m2");
    createRecipe(testAccountScope(db), "W", db, "workflow");
    const r = db.prepare(`SELECT id FROM recipes`).get() as { id: string };
    seedTable("t1");
    const a = createProject(
      testAccountScope(db),
      { name: "A", members: { addMaps: ["m1", "m2"], addRecipes: [r.id], addTables: ["t1"] } },
      db,
    );
    const b = createProject(testAccountScope(db), { name: "B", members: { addTables: ["t1"] } }, db);
    const counts = projectMemberCounts(db);
    expect(counts.get(a.id)).toEqual({ maps: 2, publishedMaps: 1, recipes: 1, tables: 1 });
    expect(counts.get(b.id)).toEqual({ maps: 0, publishedMaps: 0, recipes: 0, tables: 1 });
  });
});

describe("the export preflight's member ids", () => {
  it("returns each kind in its documented listing order, and only members", () => {
    // Distinct created_at values make the orders deterministic.
    const at = (n: number) => new Date(1756700000000 + n * 1000).toISOString();
    for (const [id, when] of [
      ["m-old", at(1)],
      ["m-new", at(3)],
      ["m-out", at(2)],
    ] as const) {
      const m = { ...seedMap(`tmp-${id}`), id, createdAt: when, updatedAt: when };
      db.prepare(`DELETE FROM maps WHERE id = ?`).run(`tmp-${id}`);
      insertMap(testAccountScope(db), m, db);
    }
    seedTable("t-old");
    seedTable("t-new");
    db.prepare(`UPDATE data_tables SET created_at = ? WHERE id = ?`).run(at(1), "t-old");
    db.prepare(`UPDATE data_tables SET created_at = ? WHERE id = ?`).run(at(2), "t-new");
    createRecipe(testAccountScope(db), "R older", db, "workflow");
    createRecipe(testAccountScope(db), "R newer", db, "workflow");
    const recipes = db
      .prepare(`SELECT id, name FROM recipes ORDER BY name`)
      .all() as { id: string; name: string }[];
    const rNewer = recipes.find((r) => r.name === "R newer")!.id;
    const rOlder = recipes.find((r) => r.name === "R older")!.id;
    db.prepare(`UPDATE recipes SET created_at = ? WHERE id = ?`).run(at(1), rOlder);
    db.prepare(`UPDATE recipes SET created_at = ? WHERE id = ?`).run(at(2), rNewer);

    const p = createProject(
      testAccountScope(db),
      {
        name: "Order proof",
        members: {
          addMaps: ["m-old", "m-new"],
          addRecipes: [rOlder, rNewer],
          addTables: ["t-old", "t-new"],
        },
      },
      db,
    );
    const ids = projectMemberIds(p.id, db);
    // Newest first, per each kind's documented listing order — and the
    // non-member m-out is absent however new it is.
    expect(ids.maps).toEqual(["m-new", "m-old"]);
    expect(ids.recipes).toEqual([rNewer, rOlder]);
    expect(ids.tables).toEqual(["t-new", "t-old"]);
    expect(() => projectMemberIds("p-none", db)).toThrow(/No project/);
  });
});
