import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";

const source = vi.hoisted(() => ({ test: vi.fn(async () => ({ serverVersion: "fixture", postgisVersion: "fixture" })) }));
vi.mock("@/lib/postgis/access", () => ({ testConnection: source.test }));
let db: Database;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  source.test.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const routes = [
  ["/api/maps", () => import("@/app/api/maps/route")],
  ["/api/maps/absent/duplicate", () => import("@/app/api/maps/[id]/duplicate/route")],
  ["/api/maps/absent/sketches", () => import("@/app/api/maps/[id]/sketches/route")],
  ["/api/tables", () => import("@/app/api/tables/route")],
  ["/api/imports/url", () => import("@/app/api/imports/url/route")],
  ["/api/imports/osm", () => import("@/app/api/imports/osm/route")],
  ["/api/imports/overture", () => import("@/app/api/imports/overture/route")],
  ["/api/imports/postgis", () => import("@/app/api/imports/postgis/route")],
  ["/api/connections/postgis", () => import("@/app/api/connections/postgis/route")],
  ["/api/projects", () => import("@/app/api/projects/route")],
  ["/api/recipes", () => import("@/app/api/recipes/route")],
  ["/api/recipes/absent/duplicate", () => import("@/app/api/recipes/[id]/duplicate/route")],
  ["/api/recipes/absent/runs", () => import("@/app/api/recipes/[id]/runs/route")],
  ["/api/recipes/absent/steps/absent/run", () => import("@/app/api/recipes/[id]/steps/[stepId]/run/route")],
  ["/api/operations/run", () => import("@/app/api/operations/run/route")],
] as const;
const tables = ["maps", "data_tables", "recipes", "projects", "pg_connections", "operation_jobs"];
const request = (path: string, body: unknown = {}) => new Request(`http://instance.test${path}`, {
  method: "POST", headers: { "content-type": "application/json", origin: "http://instance.test" }, body: JSON.stringify(body),
});

it.each(routes)("refuses scope-free creation at %s before source access or writes", async (path, load) => {
  const { POST } = await load();
  const response = await POST(socketRequest(request(path)), { params: Promise.resolve({ id: "absent", stepId: "absent" }) });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "authentication_required", message: "Sign in to continue." } });
  expect(source.test).not.toHaveBeenCalled();
  for (const table of tables) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
});

it.each(["session", "token"])("assigns each ordinary account and admin their own creations through %s authentication", async kind => {
  const { POST: map } = await import("@/app/api/maps/route");
  const { POST: project } = await import("@/app/api/projects/route");
  const { POST: recipe } = await import("@/app/api/recipes/route");
  const { POST: connection } = await import("@/app/api/connections/postgis/route");
  for (const id of ["alice", "bob", "admin"]) {
    testAccountScope(db, id);
    if (id === "admin") db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(id);
    const handlers = [
      ["maps", map, { name: id }], ["projects", project, { name: id }],
      ["recipes", recipe, { name: id, origin: "builder" }],
      ["pg_connections", connection, { name: id, host: "db.example.test", port: 5432, database: "survey", username: "reader", password: "fixture", ssl: true }],
    ] as const;
    for (const [table, handler, fields] of handlers) {
      let input = testAccountRequest(request("/api/resource", { ...fields, ownerId: "someone-else", owner_id: "someone-else" }), db, id);
      if (kind === "token") {
        const token = createApiToken(requireRequestAuth(input, db), "Creation", db);
        input.headers.delete("cookie");
        input.headers.set("authorization", `Bearer ${token.secret}`);
        input = socketRequest(input);
      }
      const response = await handler(input);
      expect(response.status, JSON.stringify(await response.json())).toBe(201);
      expect(db.prepare(`SELECT owner_id FROM ${table} WHERE name = ?`).get(id)).toEqual({ owner_id: id });
    }
  }
});

it("rechecks the account after connection testing before encrypting or committing a new connection", async () => {
  const { POST } = await import("@/app/api/connections/postgis/route");
  const scope = testAccountScope(db);
  const input = testAccountRequest(request("/api/connections/postgis", { name: "Survey", host: "db.example.test",
    database: "survey", username: "reader", password: "fixture", ssl: true }), db);
  source.test.mockImplementationOnce(async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(scope.accountId);
    return { serverVersion: "fixture", postgisVersion: "fixture" };
  });
  expect((await POST(input)).status).toBe(401);
  expect(db.prepare("SELECT * FROM pg_connections").all()).toEqual([]);
});
