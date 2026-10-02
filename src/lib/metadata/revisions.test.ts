import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "./db";
import { testAccountScope } from "@/lib/test-support/accounts";
import type { AccountScope } from "@/lib/auth/scope";
import { errorResponse } from "@/lib/api/errors";
import { permissionRefused } from "@/lib/auth/reach";
import {
  commitDocumentChanges, recordDocumentCreation, readDocumentRevision,
  recordDocumentChanges, type DocumentKey, type DocumentExpectation,
} from "./revisions";

let db: Database;
let scopes: Record<string, AccountScope>;
const map: DocumentKey = { kind: "map", id: "map" };
const workflow: DocumentKey = { kind: "workflow", id: "workflow" };
const staleMessage = "This item has changed. Reload it before trying again.";
const now = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = open(":memory:");
  scopes = Object.fromEntries(["ada", "bea", "viewer", "outside"].map(id => [id, testAccountScope(db, id)]));
  db.exec(`INSERT INTO projects (id, name, owner_id, created_at, updated_at) VALUES ('project', 'Project', 'ada', '${now}', '${now}');
    INSERT INTO project_people VALUES ('project', 'bea', 'editor', '${now}'), ('project', 'viewer', 'viewer', '${now}');
    INSERT INTO maps (id, name, owner_id, project_id, publish_token, created_at, updated_at)
      VALUES ('map', 'Before', 'ada', 'project', 'publication', '${now}', '${now}');
    INSERT INTO recipes (id, name, owner_id, project_id, origin, created_at, updated_at)
      VALUES ('workflow', 'Before', 'bea', 'project', 'workflow', '${now}', '${now}');
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES ('layer', 'map', 'Layer', 'SELECT 1', '{}', 0, '${now}', '${now}');`);
  db.transaction(() => {
    recordDocumentCreation(scopes.ada, map, db);
    recordDocumentCreation(scopes.bea, workflow, db);
  })();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function basis(doc = map): DocumentExpectation {
  return { ...doc, expectedRevision: readDocumentRevision(doc, db)!.editRevision };
}
function snapshot() {
  return ["maps", "recipes", "layers", "map_history", "data_tables", "cascade_runs"]
    .map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
}
function edit(scope: AccountScope, expected = basis(), name = "After") {
  return commitDocumentChanges(scope, {
    expected: [expected], authorize: () => {},
    apply: () => {
      const table = expected.kind === "map" ? "maps" : "recipes";
      const previous = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(expected.id) as { name: string };
      if (previous.name === name) return { value: name, changes: [] };
      db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(name, expected.id);
      return { value: name, changes: [expected] };
    },
  }, db);
}
async function refusal(action: () => unknown, status: number, code: string, message?: string) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  const response = errorResponse(failure);
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body).toEqual({ error: { code, message: message ?? expect.any(String) } });
  return body;
}

describe("document revision commit boundary", () => {
  it("records creation from the acting scope", () => {
    expect(readDocumentRevision(map, db)).toMatchObject({ editRevision: expect.stringMatching(/^[a-f0-9]{32}$/), lastChangedBy: "ada" });
    expect(readDocumentRevision(workflow, db)).toMatchObject({ lastChangedBy: "bea", executableRevision: expect.stringMatching(/^[a-f0-9]{32}$/) });
  });

  it.each([map, workflow])("accepts one writer and refuses the other on $kind, with owners and editors exchanged", async doc => {
    const expected = basis(doc);
    const first = doc.kind === "map" ? scopes.bea : scopes.ada;
    const second = doc.kind === "map" ? scopes.ada : scopes.bea;
    const accepted = edit(first, expected);
    expect(accepted.revisions).toEqual([expect.objectContaining({ ...doc, lastChangedBy: first.accountId })]);
    const before = snapshot();
    await refusal(() => edit(second, expected, "Refused"), 409, "stale_revision", staleMessage);
    expect(snapshot()).toEqual(before);
    expect(edit(second, basis(doc), "Deliberate new edit").value).toBe("Deliberate new edit");
  });

  it("checks an old basis after asynchronous validation, even for the same account and disjoint fields", async () => {
    const expected = basis();
    let release!: () => void;
    const validation = new Promise<void>(resolve => { release = resolve; });
    const late = (async () => {
      await validation;
      return () => commitDocumentChanges(scopes.ada, { expected: [expected], authorize: () => {}, apply: () => {
        db.exec("UPDATE layers SET sql = 'SELECT 2'");
        return { value: undefined, changes: [map] };
      } }, db);
    })();
    edit(scopes.ada, expected);
    const before = snapshot();
    release();
    await refusal(await late, 409, "stale_revision", staleMessage);
    expect(snapshot()).toEqual(before);
  });

  it.each([undefined, null, "", " ", "x".repeat(32), "a".repeat(31), "a".repeat(33), "A".repeat(32), '"' + "a".repeat(32) + '"', 12])(
    "refuses a missing or malformed basis (%s) before invoking the writer", async expectedRevision => {
      const before = snapshot();
      const apply = vi.fn(() => ({ value: undefined, changes: [map] }));
      const body = await refusal(() => commitDocumentChanges(scopes.ada, {
        expected: [{ ...map, expectedRevision }], authorize: () => {}, apply,
      }, db), 400, "invalid_request");
      expect(body.error.message).toMatch(/read.*X-Edit-Revision/i);
      expect(apply).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    },
  );

  it("checks the basis for a genuine no-op and advances neither token nor actor nor clocks", async () => {
    const expected = basis();
    const before = snapshot();
    const result = edit(scopes.bea, expected, "Before");
    expect(result.revisions[0].editRevision).toBe(expected.expectedRevision);
    expect(snapshot()).toEqual(before);
    edit(scopes.ada, expected);
    const accepted = snapshot();
    await refusal(() => edit(scopes.bea, expected, "After"), 409, "stale_revision", staleMessage);
    expect(snapshot()).toEqual(accepted);
  });

  it("does not reuse tokens within one clock tick or after restoring the old content", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
    const tokens = new Set([basis().expectedRevision]);
    for (const name of ["New", "Before", "New", "Before"]) {
      edit(scopes.ada, basis(), name);
      tokens.add(basis().expectedRevision);
    }
    expect(tokens.size).toBe(5);
    expect(readDocumentRevision(map, db)?.lastChangedAt).toBe(now);
  });

  it.each([map, workflow])("authorization and deactivation precede revision facts on $kind", async doc => {
    const expected = { ...doc, expectedRevision: "a".repeat(32) };
    const before = snapshot();
    await refusal(() => edit(scopes.viewer, expected), 403, "forbidden");
    await refusal(() => edit(scopes.outside, expected), 404, "not_found");
    await refusal(() => edit(scopes.ada, { ...expected, id: "missing" }), 404, "not_found");
    await refusal(() => commitDocumentChanges(scopes.bea, {
      expected: [expected], authorize: () => { throw permissionRefused(); },
      apply: () => ({ value: null, changes: [doc] }),
    }, db), 403, "forbidden");
    expect(snapshot()).toEqual(before);
    db.exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'");
    await refusal(() => edit(scopes.ada, expected), 401, "authentication_required");
    if (doc.kind === "map") await refusal(() => edit(scopes.bea, expected), 403, "forbidden");
  });

  it("checks every compound permission before any basis and every basis before any mutation", async () => {
    const expected = [basis(), basis(workflow)];
    edit(scopes.ada, expected[0]);
    db.exec("UPDATE recipes SET project_id = NULL WHERE id = 'workflow'");
    const apply = vi.fn(() => ({ value: null, changes: [map, workflow] }));
    const before = snapshot();
    await refusal(() => commitDocumentChanges(scopes.ada, { expected, authorize: () => {}, apply }, db), 404, "not_found");
    await refusal(() => commitDocumentChanges(scopes.bea, { expected, authorize: () => {}, apply }, db), 409, "stale_revision", staleMessage);
    expect(apply).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it("rolls back content, publication, history, cursor, attached data and attribution on a late failure", () => {
    const before = snapshot();
    expect(() => commitDocumentChanges(scopes.ada, {
      expected: [basis(), basis(workflow)], authorize: () => {}, apply: () => {
        db.exec(`UPDATE maps SET name = 'Lost', publish_token = NULL, history_cursor = 1;
          INSERT INTO map_history (id, map_id, seq, scope, target_id, op, created_at) VALUES ('h', 'map', 1, 'map', 'map', 'update', '${now}');
          INSERT INTO data_tables (id, name, format, file, row_count, owner_id, created_at) VALUES ('data', 'data', 'geoparquet', 'staged.parquet', 1, 'ada', '${now}');`);
        recordDocumentChanges(scopes.ada, [map, workflow], db);
        throw new Error("late commit failure");
      },
    }, db)).toThrow("late commit failure");
    expect(snapshot()).toEqual(before);
  });

  it("advances a document once for combined child changes and advances the executable basis only when requested", () => {
    const original = readDocumentRevision(workflow, db)!;
    const result = commitDocumentChanges(scopes.ada, {
      expected: [basis(workflow)], authorize: () => {}, apply: () => ({
        value: "child edits", changes: [workflow, { ...workflow, executable: true }, workflow],
      }),
    }, db);
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0].editRevision).not.toBe(original.editRevision);
    expect(result.revisions[0].executableRevision).not.toBe(original.executableRevision);
    const after = readDocumentRevision(workflow, db)!;
    edit(scopes.ada, basis(workflow), "Renamed");
    expect(readDocumentRevision(workflow, db)?.executableRevision).toBe(after.executableRevision);
  });

  it("returns only surviving, still-reachable documents and never returns a deletion token", () => {
    const result = commitDocumentChanges(scopes.ada, {
      expected: [basis(), basis(workflow)], authorize: () => {}, apply: () => {
        db.exec("DELETE FROM maps WHERE id = 'map'; UPDATE recipes SET project_id = NULL WHERE id = 'workflow'");
        return { value: "done", changes: [map, workflow] };
      },
    }, db);
    expect(result.revisions).toEqual([]);
    expect(readDocumentRevision(workflow, db)?.lastChangedBy).toBe("ada");
  });

  it("never revives a removed identity's token when its content is restored", () => {
    const expected = basis();
    const row = db.prepare("SELECT * FROM maps WHERE id = 'map'").get() as Record<string, unknown>;
    commitDocumentChanges(scopes.ada, { expected: [expected], authorize: () => {}, apply: () => {
      db.exec("DELETE FROM maps WHERE id = 'map'");
      return { value: null, changes: [map] };
    } }, db);
    db.transaction(() => {
      const fields = Object.keys(row);
      db.prepare(`INSERT INTO maps (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(row));
      recordDocumentChanges(scopes.bea, [map], db);
    })();
    expect(basis().expectedRevision).not.toBe(expected.expectedRevision);
    expect(readDocumentRevision(map, db)?.lastChangedBy).toBe("bea");
  });

  it("coalesces nested recording into one advancement per accepted parent", () => {
    db.exec(`CREATE TABLE revision_updates (id TEXT);
      CREATE TRIGGER count_revision_updates AFTER UPDATE OF edit_revision ON maps
        BEGIN INSERT INTO revision_updates VALUES (NEW.id); END;`);
    const expected = basis();
    const result = commitDocumentChanges(scopes.ada, { expected: [expected], authorize: () => {}, apply: () => {
      recordDocumentChanges(scopes.ada, [map], db);
      recordDocumentChanges(scopes.ada, [map], db);
      return { value: null, changes: [map] };
    } }, db);
    expect(db.prepare("SELECT * FROM revision_updates").all()).toEqual([{ id: "map" }]);
    expect(result.revisions[0].editRevision).not.toBe(expected.expectedRevision);
  });

  it("requires a transaction for recording and rejects undeclared changes atomically", () => {
    const before = snapshot();
    expect(() => recordDocumentChanges(scopes.ada, [map], db)).toThrow(/transaction/i);
    expect(() => commitDocumentChanges(scopes.ada, { expected: [basis()], authorize: () => {}, apply: () => {
      db.exec("UPDATE recipes SET name = 'Undeclared'");
      return { value: null, changes: [workflow] };
    } }, db)).toThrow(/declared/i);
    expect(snapshot()).toEqual(before);
  });
});
