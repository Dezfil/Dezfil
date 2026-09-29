import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";
const effects = vi.hoisted(() => ({ io: vi.fn(), afterWrite: null as null | (() => void) }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => { effects.io("read"); return actual.readFile(...args); },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      effects.io("write"); await actual.writeFile(...args); const hook = effects.afterWrite; effects.afterWrite = null; hook?.();
    },
    rename: async (...args: Parameters<typeof actual.rename>) => { effects.io("rename"); return actual.rename(...args); },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => { effects.io("copy"); return actual.copyFile(...args); },
    rm: async (...args: Parameters<typeof actual.rm>) => { effects.io("remove"); return actual.rm(...args); },
  };
});
const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let db: Database, dir: string, maps: Record<string, string>;
const accounts = ["alice", "bob", "admin"];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(process.cwd(), ".claude/test-data/thumbnail-")); vi.stubEnv("DEZFIL_DATA_DIR", dir);
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); maps = {};
  await fs.mkdir(path.join(dir, "thumbnails"));
  for (const account of accounts) {
    maps[account] = createMap(testAccountScope(db, account), `Private ${account}`).id;
    await fs.writeFile(path.join(dir, "thumbnails", `${maps[account]}.png`), png);
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run(); effects.afterWrite = null; vi.clearAllMocks();
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
function input(account: string, id: string, method = "GET", kind = "session", query = "") {
  const request = testAccountRequest(new Request(`http://instance.test/api/maps/${id}/thumbnail${query}`, {
    method, ...(method === "PUT" ? { body: png } : {}),
  }), db, account);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(request, db), "Thumbnails", db);
    request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return request;
}
async function snapshot() {
  const names = (await fs.readdir(path.join(dir, "thumbnails"))).sort();
  return Promise.all(names.map(async name => [name, (await fs.readFile(path.join(dir, "thumbnails", name))).toString("base64")]));
}
it.each(["GET", "PUT"])("refuses hidden thumbnail %s through sessions and tokens before file access", async method => {
  const route = await import("@/app/api/maps/[id]/thumbnail/route"); const handler = method === "GET" ? route.GET : route.PUT;
  const before = await snapshot();
  for (const kind of ["session", "token"]) for (const account of accounts) for (const other of accounts.filter(a => a !== account)) {
    const hidden = await handler(input(account, maps[other], method, kind), { params: Promise.resolve({ id: maps[other] }) });
    const absent = await handler(input(account, "missing", method, kind), { params: Promise.resolve({ id: "missing" }) });
    expect(hidden.status).toBe(404); expect(absent.status).toBe(404); expect(await hidden.json()).toEqual(await absent.json());
    expect(await snapshot()).toEqual(before); expect(effects.io).not.toHaveBeenCalled();
  }
});
it("requires service scopes and validates both copy parents before filesystem work", async () => {
  const service = await import("@/lib/map-thumbnails");
  const call = (fn: unknown, ...args: unknown[]) => Promise.resolve().then(() => (fn as (...values: unknown[]) => unknown)(...args));
  const actions = (scope: unknown, id: string) => [
    () => call(service.readThumbnail, scope, id), () => call(service.saveThumbnail, scope, id, png),
    () => call(service.saveThemedThumbnail, scope, id, "light", "cycle", png),
    () => call(service.removeThumbnail, scope, id),
    () => call(service.copyThumbnail, scope, id, maps.alice), () => call(service.copyThumbnail, scope, maps.alice, id),
  ];
  const before = await snapshot();
  for (const scope of [undefined, null, { accountId: "alice" }]) for (const action of actions(scope, maps.alice)) {
    await expect(action()).rejects.toMatchObject({ code: "authentication_required", status: 401 });
  }
  for (const id of [maps.bob, "missing"]) for (const action of actions(testAccountScope(db, "alice"), id)) {
    await expect(action()).rejects.toMatchObject({ code: "not_found", status: 404 });
  }
  expect(await snapshot()).toEqual(before); expect(effects.io).not.toHaveBeenCalled();
});
it("rechecks activity after the upload body arrives", async () => {
  const { PUT } = await import("@/app/api/maps/[id]/thumbnail/route");
  const request = input("alice", maps.alice, "PUT");
  vi.spyOn(request, "arrayBuffer").mockImplementation(async () => {
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
    return Uint8Array.from([...png, 2]).buffer;
  });
  const before = await snapshot();
  expect((await PUT(request, { params: Promise.resolve({ id: maps.alice }) })).status).toBe(401);
  expect(await snapshot()).toEqual(before); expect(effects.io).not.toHaveBeenCalled();
});
it.each(["", "?theme=light&cycle=next"])("refuses a staged thumbnail commit after deactivation (%s)", async query => {
  const { PUT } = await import("@/app/api/maps/[id]/thumbnail/route");
  const before = await snapshot();
  effects.afterWrite = () => { db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); };
  expect((await PUT(input("alice", maps.alice, "PUT", "session", query), { params: Promise.resolve({ id: maps.alice }) })).status).toBe(401);
  expect(await snapshot()).toEqual(before);
});
it("does not follow a stored thumbnail manifest into another map's files", async () => {
  const { GET } = await import("@/app/api/maps/[id]/thumbnail/route");
  await fs.writeFile(path.join(dir, "thumbnails", `${maps.bob}.png`), Buffer.from("Private other image"));
  await fs.writeFile(path.join(dir, "thumbnails", `${maps.alice}.json`), JSON.stringify({ light: `${maps.bob}.png`, dark: `${maps.bob}.png` }));
  const response = await GET(input("alice", maps.alice), { params: Promise.resolve({ id: maps.alice }) });
  expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
});
