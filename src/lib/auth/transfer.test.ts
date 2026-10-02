import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, createApiToken, issueSession } from "./credentials";
import { ACTION_RULES, PERMISSION_REFUSAL } from "./reach";

/**
 * Transfer, through the ownership gate.
 *
 * Pat owns project P (with a note); Ada and Ed are its editors, Vi its viewer
 * and Dee a member whose account is deactivated. Bo is active and outside
 * the project, Out an admin outside it, Ivy an invitation never redeemed.
 * Ada files her maps M and N and her workflow W into P and keeps map U and
 * workflow X unfiled; Pat files his dataset E and Ada her dataset D. M has a
 * layer, a history entry and a publication; W a step, a run Ed started and
 * the per-runner output it made.
 *
 * A project goes from its owner to one of its active members: the recipient
 * leaves the member list, the previous owner becomes an editor, and nothing
 * else moves. A map or workflow goes from its owner to another active person
 * who already reaches it through its project; an unfiled one must be filed
 * first. Everyone else is refused by the shape their standing earns, and a
 * refusal, or a failure anywhere inside the gate, changes nothing and leaves
 * no gate behind.
 */
let db: Database;
const now = "2026-01-01T00:00:00.000Z";
const origin = "http://instance.test";
const sessions = new Map<string, string>();
const tokens = new Map<string, string>();

beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  sessions.clear(); tokens.clear();
  for (const id of ["pat", "ada", "ed", "vi", "dee", "bo", "out", "ivy"]) testAccountScope(db, id);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'out'").run();
  db.exec(`INSERT INTO projects (id, name, note, created_at, updated_at, owner_id) VALUES ('P', 'Survey', 'Keep this', '${now}', '${now}', 'pat');
    INSERT INTO project_people VALUES ('P', 'ada', 'editor', '${now}'), ('P', 'ed', 'editor', '${now}'), ('P', 'vi', 'viewer', '${now}'),
      ('P', 'dee', 'viewer', '${now}');
    INSERT INTO maps (id, name, created_at, updated_at, owner_id, project_id, publish_token) VALUES
      ('M', 'Filed map', '${now}', '${now}', 'ada', 'P', 'tok-M'), ('N', 'Other map', '${now}', '${now}', 'ada', 'P', NULL),
      ('U', 'Unfiled map', '${now}', '${now}', 'ada', NULL, NULL);
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at) VALUES ('L', 'M', 'Roads', 'SELECT * FROM roads', '{}', 0, '${now}', '${now}');
    INSERT INTO map_history (id, map_id, seq, scope, target_id, op, created_at) VALUES ('H', 'M', 1, 'map', 'M', 'update', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, owner_id, project_id) VALUES
      ('W', 'Filed workflow', 'workflow', '${now}', '${now}', 'ada', 'P'), ('X', 'Unfiled workflow', 'workflow', '${now}', '${now}', 'ada', NULL);
    INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, created_at, updated_at) VALUES ('S', 'W', 0, 'sql_step', '{}', '${now}', '${now}');
    INSERT INTO cascade_runs (id, recipe_id, kind, started_at, initiator_id) VALUES ('R', 'W', 'single', '${now}', 'ed');
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id) VALUES ('D', 'roads', 'geoparquet', 'tables/d.parquet', 1, '${now}', 'ada'),
      ('E', 'rivers', 'geoparquet', 'tables/e.parquet', 1, '${now}', 'pat'), ('O', 'out', 'geoparquet', 'tables/o.parquet', 1, '${now}', 'ed');
    INSERT INTO step_runner_outputs (step_id, runner_id, output_table_id, output_table_name, run_id, succeeded_at) VALUES ('S', 'ed', 'O', 'out', 'R', '${now}');
    INSERT INTO project_datasets VALUES ('P', 'D', '${now}'), ('P', 'E', '${now}');`);
  for (const id of ["pat", "ada", "ed", "vi", "dee", "bo", "out"]) credentials(id);
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'dee'").run();
  db.prepare("UPDATE accounts SET status = 'invited' WHERE id = 'ivy'").run();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function credentials(account: string) {
  const secret = issueSession(getAccount(account, db)!, db, Date.now()).secret;
  sessions.set(account, secret);
  tokens.set(account, createApiToken(authenticateSession(secret, db)!, "Transfer", db).secret);
}
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes = {
  project: { load: () => import("@/app/api/projects/[id]/transfer/route"), path: (id: string) => `/api/projects/${id}/transfer` },
  map: { load: () => import("@/app/api/maps/[id]/transfer/route"), path: (id: string) => `/api/maps/${id}/transfer` },
  workflow: { load: () => import("@/app/api/recipes/[id]/transfer/route"), path: (id: string) => `/api/recipes/${id}/transfer` },
  readProject: { load: () => import("@/app/api/projects/[id]/route"), path: (id: string) => `/api/projects/${id}` },
  people: { load: () => import("@/app/api/projects/[id]/people/route"), path: (id: string) => `/api/projects/${id}/people` },
};
async function call(route: keyof typeof routes, account: string, id: string, body?: unknown,
  kind: "session" | "token" = "session", method = "POST") {
  const headers = new Headers({ "content-type": "application/json", origin });
  if (kind === "token") headers.set("authorization", `Bearer ${tokens.get(account)}`);
  else headers.set("cookie", `dezfil_session=${sessions.get(account)}`);
  const request = socketRequest(new Request(`${origin}${routes[route].path(id)}`, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const handler = ((await routes[route].load()) as Record<string, unknown>)[method] as Handler;
  const response = await handler(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() as unknown };
}
const sqlName = (id: string) => getAccount(id, db)!.sqlName;
const to = (id: string) => ({ to: sqlName(id) });
function snapshot() {
  return ["projects", "project_people", "maps", "layers", "map_history", "recipes", "recipe_steps", "cascade_runs",
    "step_runner_outputs", "data_tables", "project_datasets", "ownership_transfer_gate"]
    .map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1, 2`).all());
}
const row = (table: string, id: string) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
const without = (record: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
const gate = () => db.prepare("SELECT * FROM ownership_transfer_gate").all();
const forbidden = { status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } };
const refusal = (message: string) => ({ status: 400, body: { error: { code: "invalid_request", message } } });

describe("transferring a project", () => {
  it("makes a member the owner, the previous owner an editor, and leaves name, note, people and contents as they were", async () => {
    const before = { project: row("projects", "P"), maps: db.prepare("SELECT id, owner_id, project_id FROM maps ORDER BY id").all(),
      recipes: db.prepare("SELECT id, owner_id, project_id FROM recipes ORDER BY id").all(), datasets: db.prepare("SELECT * FROM project_datasets ORDER BY 2").all() };
    const response = await call("project", "pat", "P", to("ed"), "token");
    expect(response).toEqual({ status: 200, body: { id: "P", owner: { name: "ed", sqlName: sqlName("ed") } } });
    expect(row("projects", "P")).toEqual({ ...before.project, owner_id: "ed" });
    expect(db.prepare("SELECT account_id, role FROM project_people WHERE project_id = 'P' ORDER BY 1").all()).toEqual([
      { account_id: "ada", role: "editor" }, { account_id: "dee", role: "viewer" }, { account_id: "pat", role: "editor" }, { account_id: "vi", role: "viewer" }]);
    expect(db.prepare("SELECT id, owner_id, project_id FROM maps ORDER BY id").all()).toEqual(before.maps);
    expect(db.prepare("SELECT id, owner_id, project_id FROM recipes ORDER BY id").all()).toEqual(before.recipes);
    expect(db.prepare("SELECT * FROM project_datasets ORDER BY 2").all()).toEqual(before.datasets);
    expect(gate()).toEqual([]);
    // The next request on the same credentials reads the new standing.
    expect(await call("readProject", "pat", "P", undefined, "session", "GET")).toMatchObject({ status: 200, body: { role: "editor", owner: { sqlName: sqlName("ed") } } });
    expect(await call("readProject", "ed", "P", undefined, "session", "GET")).toMatchObject({ status: 200, body: { role: "owner" } });
    const people = await call("people", "vi", "P", undefined, "session", "GET");
    expect((people.body as { people: { sqlName: string; role: string }[] }).people.slice(0, 1)).toEqual([expect.objectContaining({ sqlName: sqlName("ed"), role: "owner" })]);
    expect(await call("project", "pat", "P", to("ed"))).toEqual(forbidden);
  });

  it("goes to a viewer as well, who leaves the member list", async () => {
    expect((await call("project", "pat", "P", to("vi"))).status).toBe(200);
    expect(row("projects", "P").owner_id).toBe("vi");
    expect(db.prepare("SELECT account_id FROM project_people WHERE project_id = 'P' AND account_id = 'vi'").all()).toEqual([]);
  });

  it("refuses its members by the permission shape and outsiders and admins by the absent one, with nothing changed", async () => {
    const before = snapshot();
    for (const account of ["ada", "vi"]) {
      expect(await call("project", account, "P", to("ed")), account).toEqual(forbidden);
      expect(await call("project", account, "P", to("ed"), "token"), account).toEqual(forbidden);
    }
    for (const account of ["bo", "out"]) {
      const missing = await call("project", account, "never", to("ed"));
      expect(missing.status).toBe(404);
      expect(await call("project", account, "P", to("ed")), account).toEqual(missing);
      expect(await call("project", account, "P", to("ed"), "token"), account).toEqual(missing);
    }
    expect(snapshot()).toEqual(before);
  });

  it("refuses anyone who is not an active member, the owner included, alike and with nothing changed", async () => {
    const before = snapshot();
    const notMember = refusal("Transfer a project only to one of its active members.");
    for (const account of ["dee", "bo", "ivy", "out", "pat"]) {
      expect(await call("project", "pat", "P", to(account)), account).toEqual(notMember);
    }
    expect(await call("project", "pat", "P", { to: "nobody_here" })).toEqual(notMember);
    for (const body of [{}, { to: "" }, { to: 4 }, null]) {
      expect((await call("project", "pat", "P", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe("transferring a map or a workflow", () => {
  const kinds = [
    { kind: "map" as const, route: "map" as const, table: "maps", filed: "M", unfiled: "U", noun: "map" },
    { kind: "workflow" as const, route: "workflow" as const, table: "recipes", filed: "W", unfiled: "X", noun: "workflow" },
  ];
  describe.each(kinds)("a $kind", ({ route, table, filed, unfiled, noun }) => {
    it("goes to the project's owner or a member, keeping its home and everything in it", async () => {
      const before = snapshot();
      const record = row(table, filed);
      const response = await call(route, "ada", filed, to("ed"), "token");
      expect(response).toEqual({ status: 200, body: { id: filed, owner: { name: "ed", sqlName: sqlName("ed") } } });
      expect(row(table, filed)).toEqual({ ...record, owner_id: "ed" });
      expect(row(table, filed).home_account_id).toBe("ada");
      const after = snapshot();
      const ownerless = (tables: unknown[][]) => tables.map(rows => (rows as Record<string, unknown>[]).map(entry =>
        entry.id === filed && "owner_id" in entry ? without(entry, "owner_id") : entry));
      expect(ownerless(after)).toEqual(ownerless(before));
      expect(gate()).toEqual([]);
      // And on to the project's owner from there.
      expect((await call(route, "ed", filed, to("pat"))).status).toBe(200);
      expect(row(table, filed)).toEqual({ ...record, owner_id: "pat" });
    });

    it(`refuses an unfiled ${noun} with the one reason, file it first`, async () => {
      const before = snapshot();
      expect(await call(route, "ada", unfiled, to("ed"))).toEqual(
        refusal(`File the ${noun} in a project first: only someone who already reaches it can receive it.`));
      expect(snapshot()).toEqual(before);
    });

    it("refuses a recipient who is deactivated, invited, outside its project, unknown or its owner, alike", async () => {
      const before = snapshot();
      const unreachable = refusal(`Transfer a ${noun} only to another active person who already reaches it.`);
      for (const account of ["dee", "ivy", "bo", "out", "ada"]) {
        expect(await call(route, "ada", filed, to(account)), account).toEqual(unreachable);
      }
      expect(await call(route, "ada", filed, { to: "nobody_here" })).toEqual(unreachable);
      expect(snapshot()).toEqual(before);
    });

    it("refuses everyone but its owner: reachers by the permission shape, outsiders and admins as absent", async () => {
      const before = snapshot();
      for (const account of ["pat", "ed", "vi"]) {
        expect(await call(route, account, filed, to("ed")), account).toEqual(forbidden);
        expect(await call(route, account, filed, to("ed"), "token"), account).toEqual(forbidden);
      }
      for (const account of ["bo", "out"]) {
        const missing = await call(route, account, "never", to("ed"));
        expect(missing.status).toBe(404);
        expect(await call(route, account, filed, to("ed")), account).toEqual(missing);
        expect(await call(route, account, unfiled, to("ed"), "token"), account).toEqual(missing);
      }
      expect(snapshot()).toEqual(before);
    });

    it("is unavailable while its owner is deactivated, to the project's owner and the deactivated owner alike", async () => {
      db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
      const before = snapshot();
      expect(await call(route, "pat", filed, to("ed"))).toEqual(forbidden);
      expect((await call(route, "ada", filed, to("ed"))).status).toBe(401);
      expect(snapshot()).toEqual(before);
    });
  });
});

describe("the gate", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  /** The failure the route answered is the injected one, not another. */
  const failedWith = (message: string) => expect(String((logged.mock.calls.at(-1) as unknown[] | undefined)?.[1])).toContain(message);
  beforeEach(() => { logged = vi.spyOn(console, "error").mockImplementation(() => {}); });

  it("refuses a change to any other resource while it is open, and the whole transfer rolls back", async () => {
    db.exec(`CREATE TEMP TRIGGER wrong_resource AFTER UPDATE OF owner_id ON maps WHEN NEW.id = 'M'
      BEGIN UPDATE maps SET owner_id = NEW.owner_id WHERE id = 'N'; END;`);
    const before = snapshot();
    expect((await call("map", "ada", "M", to("ed"))).status).toBe(500);
    failedWith("Ownership cannot change");
    expect(snapshot()).toEqual(before);
    expect(gate()).toEqual([]);
    db.exec("DROP TRIGGER temp.wrong_resource");
    db.exec(`CREATE TEMP TRIGGER wrong_project AFTER UPDATE OF owner_id ON projects WHEN NEW.id = 'P'
      BEGIN UPDATE maps SET owner_id = NEW.owner_id WHERE id = 'M'; END;`);
    expect((await call("project", "pat", "P", to("ed"))).status).toBe(500);
    failedWith("Ownership cannot change");
    expect(snapshot()).toEqual(before);
  });

  it("rolls everything back when the role adjustment fails after the ownership update", async () => {
    db.exec(`CREATE TEMP TRIGGER failing_role BEFORE INSERT ON project_people WHEN NEW.account_id = 'pat'
      BEGIN SELECT RAISE(ABORT, 'injected role adjustment failure'); END;`);
    const before = snapshot();
    expect((await call("project", "pat", "P", to("ed"))).status).toBe(500);
    failedWith("injected role adjustment failure");
    expect(snapshot()).toEqual(before);
    expect(row("projects", "P").owner_id).toBe("pat");
    expect(db.prepare("SELECT role FROM project_people WHERE project_id = 'P' AND account_id = 'ed'").get()).toEqual({ role: "editor" });
    expect(gate()).toEqual([]);
  });

  it.each([["project", "P", "pat"], ["map", "M", "ada"], ["workflow", "W", "ada"]] as const)(
    "rolls a %s transfer back completely when closing the gate fails after the update", async (route, id, owner) => {
      db.exec(`CREATE TEMP TRIGGER failing_close BEFORE DELETE ON ownership_transfer_gate
        BEGIN SELECT RAISE(ABORT, 'injected failure after the update'); END;`);
      const before = snapshot();
      expect((await call(route, owner, id, to("ed"))).status).toBe(500);
      failedWith("injected failure after the update");
      expect(snapshot()).toEqual(before);
      expect(gate()).toEqual([]);
    });

  it("leaves no gate behind after a success or a refusal, and admits no further change once closed", async () => {
    expect((await call("map", "ada", "M", to("ed"))).status).toBe(200);
    expect(await call("map", "ada", "N", to("bo"))).toMatchObject({ status: 400 });
    expect(gate()).toEqual([]);
    expect(() => db.prepare("UPDATE maps SET owner_id = 'ada' WHERE id = 'M'").run()).toThrow("Ownership cannot change");
    expect(() => db.prepare("UPDATE projects SET owner_id = 'ed' WHERE id = 'P'").run()).toThrow("Ownership cannot change");
  });
});

describe("what cannot be transferred", () => {
  it("offers no transfer of a dataset or a connection, and the kernel names none", () => {
    const paths = Object.keys((buildOpenApiDocument() as unknown as { paths: Record<string, unknown> }).paths);
    expect(paths.filter(path => path.endsWith("/transfer")).sort()).toEqual(
      ["/api/maps/{id}/transfer", "/api/projects/{id}/transfer", "/api/recipes/{id}/transfer"]);
    expect(Object.keys(ACTION_RULES.dataset)).not.toContain("transfer");
    expect(Object.keys(ACTION_RULES.map)).toContain("transfer");
  });
});
