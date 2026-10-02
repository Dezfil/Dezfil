import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "./db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { createRecipe } from "./recipes";
import { readDocumentRevision, type DocumentKey } from "./revisions";
import { createProject, changeMembers, deleteProject, fileMap, fileRecipe, updateProject } from "./owned-projects";
import { transferMap, transferWorkflow } from "./transfers";
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const facts = (doc: DocumentKey) => readDocumentRevision(doc, db)!;
function fixture() {
  const owner = testAccountScope(db), editor = testAccountScope(db, "editor");
  const map = { kind: "map" as const, id: createMap(owner, "Map").id };
  const workflow = { kind: "workflow" as const, id: createRecipe(owner, "Workflow", db).id };
  const project = createProject(owner, { name: "Project" }, db);
  db.prepare("INSERT INTO project_people VALUES (?, 'editor', 'editor', 't')").run(project.id);
  return { owner, editor, map, workflow, project };
}
it("records direct and compound filing while preserving no-ops and executable generations", () => {
  const { owner, map, workflow, project } = fixture();
  const before = [facts(map), facts(workflow)];
  fileMap(owner, map.id, project.id, db); fileRecipe(owner, workflow.id, project.id, db);
  const filed = [facts(map), facts(workflow)];
  for (let i = 0; i < 2; i++) expect(filed[i].editRevision).not.toBe(before[i].editRevision);
  expect(filed[1].executableRevision).toBe(before[1].executableRevision);
  changeMembers(owner, project.id, { addMaps: [map.id], addRecipes: [workflow.id] }, db);
  updateProject(owner, project.id, { name: "Renamed" }, db);
  expect([facts(map), facts(workflow)]).toEqual(filed);
  changeMembers(owner, project.id, { removeMaps: [map.id], removeRecipes: [workflow.id] }, db);
  expect(facts(map).editRevision).not.toBe(filed[0].editRevision);
  expect(facts(workflow).editRevision).not.toBe(filed[1].editRevision);
});
it("rolls back facts with a refused compound filing", () => {
  const { owner, map, workflow, project } = fixture();
  const before = [facts(map), facts(workflow)];
  expect(() => changeMembers(owner, project.id, { addMaps: [map.id], addRecipes: [workflow.id], addTables: ["missing"] }, db)).toThrow();
  expect([facts(map), facts(workflow)]).toEqual(before);
  expect(db.prepare("SELECT project_id FROM maps WHERE id = ?").get(map.id)).toEqual({ project_id: null });
});
it("attributes transfers and dissolution to their acting account, preserving executable meaning", () => {
  const { owner, map, workflow, project } = fixture();
  changeMembers(owner, project.id, { addMaps: [map.id], addRecipes: [workflow.id] }, db);
  const before = [facts(map), facts(workflow)];
  transferMap(owner, map.id, "editor", db); transferWorkflow(owner, workflow.id, "editor", db);
  const transferred = [facts(map), facts(workflow)];
  for (let i = 0; i < 2; i++) {
    expect(transferred[i].editRevision).not.toBe(before[i].editRevision);
    expect(transferred[i].lastChangedBy).toBe(owner.accountId);
  }
  deleteProject(owner, project.id, db);
  for (const [i, doc] of [map, workflow].entries()) {
    expect(facts(doc).editRevision).not.toBe(transferred[i].editRevision);
    expect(facts(doc).lastChangedBy).toBe(owner.accountId);
    expect(facts(doc).executableRevision).toBe(before[i].executableRevision);
  }
});
it("records a creation filed at birth only once", () => {
  const { owner, project } = fixture();
  db.exec(`CREATE TABLE recorded (id TEXT);
    CREATE TRIGGER count_recording AFTER UPDATE OF last_changed_by ON maps
    BEGIN INSERT INTO recorded VALUES (NEW.id); END;`);
  const map = createMap(owner, "Filed at birth", project.id);
  expect(db.prepare("SELECT COUNT(*) AS n FROM recorded WHERE id = ?").get(map.id)).toEqual({ n: 1 });
});
