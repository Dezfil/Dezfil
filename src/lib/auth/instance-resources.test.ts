import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { createCustomPalette, listCustomPalettes } from "@/lib/metadata/palettes";
import { GET as config } from "@/app/api/config/route";
import { GET as palettes, POST as savePalette } from "@/app/api/palettes/route";
import { DELETE as deletePalette } from "@/app/api/palettes/[name]/route";
import { GET as operations } from "@/app/api/operations/route";
import { GET as reference } from "@/app/api/openapi.json/route";
import { GET as projections } from "@/app/api/geometry/projections/route";
import { GET as imagery } from "@/app/api/basemaps/satellite/route";
import { GET as models } from "@/app/api/assistant/route";
import { GET as profile, PATCH as updateProfile } from "@/app/api/account/route";
import { GET as settings, PATCH as updateSettings } from "@/app/api/settings/route";
import { GET as users, POST as invite } from "@/app/api/users/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { gateRequest } from "./gate";

const origin = "http://instance.test", actors = ["alice", "bob", "admin"];
const stops = [{ color: "#123456", position: 0 }, { color: "#abcdef", position: 1 }];
const secret = "server-key-sentinel-never-sent";
let db: Database;
const catalogues: [string, (request: Request) => Promise<Response>][] = [
  ["/api/config", config], ["/api/palettes", palettes], ["/api/operations", operations],
  ["/api/openapi.json", reference], ["/api/geometry/projections", projections],
  ["/api/basemaps/satellite", imagery], ["/api/assistant", models],
];
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const id of actors) testAccountScope(db, id);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  vi.stubEnv("OPENAI_API_KEY", secret); vi.stubEnv("ANTHROPIC_API_KEY", secret + "-other");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai"); vi.stubEnv("DEZFIL_AI_MODEL", "gpt-5.6-terra");
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-5.6-terra");
  vi.stubEnv("DEZFIL_BASEMAP_URL", "https://deployment.test/style.json");
  vi.stubEnv("DEZFIL_SATELLITE_URL", "https://deployment.test/{z}/{x}/{y}.png");
  vi.stubEnv("DEZFIL_GEOCODER_URL", "https://geocoder.test/?key=" + secret);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Catalogues must not contact providers."); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });
function request(actor: string, path: string, method = "GET", body?: unknown, kind = "session") {
  const input = testAccountRequest(new Request(origin + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), db, actor);
  if (kind === "token") {
    const token = createApiToken(requireRequestAuth(input, db), "Instance controls", db);
    input.headers.delete("cookie"); input.headers.set("authorization", `Bearer ${token.secret}`);
  }
  return input;
}
const snapshot = () => ["accounts", "account_preferences", "workspace_settings", "custom_palettes"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

it.each(catalogues)("authenticates the shared %s catalogue at both gate and adapter", async (path, read) => {
  for (const headers of [{}, { authorization: "Bearer invalid" }] as Record<string, string>[]) {
    const input = socketRequest(new Request(origin + path, { headers }));
    expect(gateRequest(new NextRequest(input.clone())).status).toBe(401);
    const response = await read(input);
    expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ error: { code: "authentication_required" } });
  }
});
it.each(["session", "token"])("shares configured and built-in catalogues through %s without credential values or provider calls", async kind => {
  const saved = createCustomPalette({ label: "Shared ramp", stops }, db);
  for (const [path, read] of catalogues) {
    const payloads = [];
    for (const actor of actors) {
      const input = request(actor, path, "GET", undefined, kind);
      expect(gateRequest(new NextRequest(input.clone())).headers.get("x-middleware-next")).toBe("1");
      const response = await read(input); expect(response.status).toBe(200);
      const body = await response.json(); payloads.push(body);
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toMatch(/alice@example|bob@example|admin@example|secret_hash|password_hash/);
    }
    expect(payloads[1]).toEqual(payloads[0]); expect(payloads[2]).toEqual(payloads[0]);
    if (path === "/api/config") expect(payloads[0]).toMatchObject({ geocoderConfigured: true, basemapOverrideUrl: "https://deployment.test/style.json", basemaps: expect.arrayContaining([expect.objectContaining({ key: "dark" }), expect.objectContaining({ key: "satellite" })]) });
    if (path === "/api/palettes") expect(payloads[0]).toMatchObject({ custom: [saved], curated: expect.any(Object) });
    if (path === "/api/assistant") expect(payloads[0]).toMatchObject({ enabled: true, provider: "openai", models: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.6-terra" })]) });
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("refuses anonymous and cross-site palette mutations at the adapter without changing the shared catalogue", async () => {
  const saved = createCustomPalette({ label: "Keep", stops }, db);
  for (const operation of ["save", "delete"] as const) for (const mode of ["anonymous", "cross-site"] as const) {
    const path = "/api/palettes" + (operation === "delete" ? `/${saved.name}` : "");
    const input = mode === "anonymous" ? socketRequest(new Request(origin + path, { method: operation === "save" ? "POST" : "DELETE", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ label: "Forbidden", stops }) })) : request("alice", path, operation === "save" ? "POST" : "DELETE", { label: "Forbidden", stops });
    if (mode === "cross-site") input.headers.set("origin", "https://unrelated.test");
    const before = snapshot();
    const response = operation === "save" ? await savePalette(input) : await deletePalette(input, { params: Promise.resolve({ name: saved.name }) });
    expect(response.status).toBe(mode === "anonymous" ? 401 : 403); expect(snapshot()).toEqual(before);
  }
});
it.each(["session", "token"])("lets both ordinary accounts create and delete each other's saved palettes through %s", async kind => {
  for (const [creator, remover] of [["alice", "bob"], ["bob", "alice"]]) {
    const created = await savePalette(request(creator, "/api/palettes", "POST", { label: `${creator} shared ramp`, stops }, kind));
    expect(created.status).toBe(201); const saved = await created.json();
    const offered = await (await palettes(request(remover, "/api/palettes", "GET", undefined, kind))).json();
    expect(offered.custom).toContainEqual(saved);
    expect((await deletePalette(request(remover, `/api/palettes/${saved.name}`, "DELETE", undefined, kind), { params: Promise.resolve({ name: saved.name }) })).status).toBe(200);
    expect(listCustomPalettes(db)).toEqual([]);
  }
});
it.each(["save", "delete"])("rechecks account activity after awaiting palette %s input", async operation => {
  const saved = createCustomPalette({ label: "Keep", stops }, db), before = listCustomPalettes(db);
  const input = request("alice", "/api/palettes", operation === "save" ? "POST" : "DELETE", { label: "Late", stops });
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  if (operation === "save") vi.spyOn(input, "json").mockImplementation(async () => { await barrier; return { label: "Late", stops }; });
  const pending = operation === "save" ? savePalette(input) : deletePalette(input, { params: barrier.then(() => ({ name: saved.name })) });
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run(); finish();
  expect((await pending).status).toBe(401); expect(listCustomPalettes(db)).toEqual(before);
});
it.each(["session", "token"])("keeps profiles and preferences personal and instance/user changes admin-only through %s", async kind => {
  for (const actor of actors) {
    expect((await updateProfile(request(actor, "/api/account", "PATCH", { name: `${actor} personal` }, kind))).status).toBe(200);
    expect((await updateSettings(request(actor, "/api/settings", "PATCH", { viewPrefs: { maps: { view: actor === "bob" ? "list" : "grid", sort: actor === "admin" ? "name" : "edited" } } }, kind))).status).toBe(200);
  }
  for (const actor of ["alice", "bob"]) {
    const before = snapshot();
    expect((await updateSettings(request(actor, "/api/settings", "PATCH", { displayName: "Overwrite", instanceName: "Hijacked" }, kind))).status).toBe(403);
    expect((await users(request(actor, "/api/users", "GET", undefined, kind))).status).toBe(403);
    expect((await invite(request(actor, "/api/users", "POST", { name: "Intruder", email: "new@example.test" }, kind))).status).toBe(403);
    expect(snapshot()).toEqual(before);
  }
  expect((await updateSettings(request("admin", "/api/settings", "PATCH", { instanceName: "Shared instance" }, kind))).status).toBe(200);
  expect((await users(request("admin", "/api/users", "GET", undefined, kind))).status).toBe(200);
  expect((await invite(request("admin", "/api/users", "POST", { name: "Invited", email: "new@example.test" }, kind))).status).toBe(201);
  for (const actor of actors) {
    const own = await (await profile(request(actor, "/api/account", "GET", undefined, kind))).json();
    expect(own.account).toMatchObject({ id: actor, name: `${actor} personal` });
    const prefs = await (await settings(request(actor, "/api/settings", "GET", undefined, kind))).json();
    expect(prefs).toEqual({ displayName: `${actor} personal`, instanceName: "Shared instance", viewPrefs: { maps: { view: actor === "bob" ? "list" : "grid", sort: actor === "admin" ? "name" : "edited" } } });
    expect(JSON.stringify([own, prefs])).not.toContain(secret);
  }
});
