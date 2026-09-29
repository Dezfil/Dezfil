import { accountScope } from "./scope";
import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { POST as image } from "@/app/api/maps/[id]/export/image/route";
import { POST as look } from "@/app/api/maps/look/route";
import { GET as retained } from "@/app/api/maps/look/[renderId]/route";
import { createMap } from "@/lib/map-service";
import { renderMapImage } from "@/lib/export/render-image";
import { encodePng } from "@/lib/export/png-codec";
import { lookRetention } from "@/lib/export/look-retention";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { inviteAccount } from "./admin";
import { redeemSignInLink } from "./links";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken, revokeApiToken, signOut } from "./credentials";
import { authenticateDelegation, DELEGATION_LIFETIME_MS } from "./delegation";
import { gateRequest } from "./gate";

vi.mock("@/lib/export/render-image", () => ({ renderMapImage: vi.fn() }));
const origin = "http://127.0.0.1:3216";
let db: Database, signed: Awaited<ReturnType<typeof createFirstAccount>>, token: ReturnType<typeof createApiToken>, mapId: string;
const definition = { viewport: { lng: 0, lat: 0, zoom: 2, pitch: 0, bearing: 0 }, size: { width: 512, height: 256 }, mapScale: 1,
  legend: { visible: false, corner: "top-right", size: "m" }, widgets: [], title: null, appearance: "light" };
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); vi.stubEnv("PORT", "3216");
  signed = await createFirstAccount({ name: "Caller", email: "caller@example.test", password: "field notebooks at dawn" }, db);
  token = createApiToken(authenticateSession(signed.secret, db)!, "Render CLI", db); mapId = createMap(accountScope(authenticateSession(signed.secret, db)!, db), "Private image").id;
  lookRetention.resetForTests();
  vi.mocked(renderMapImage).mockReset().mockImplementation(async (_scope, input) => ({
    png: encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).fill(200) }), abandoned: [],
    consumed: JSON.stringify({ map: input.mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "Fixture", failures: [] }),
  }));
});
afterEach(() => { lookRetention.resetForTests(); vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });
const cookie = () => ({ cookie: `dezfil_session=${signed.secret}` });
const bearer = () => ({ authorization: `Bearer ${token.secret}` });
function request(path: string, method: string, body: unknown, headers: Record<string, string>) {
  return socketRequest(new Request(origin + path, { method, headers: { origin, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
function invoke(operation: string, headers: Record<string, string>) {
  if (operation === "image") return image(request(`/api/maps/${mapId}/export/image`, "POST", { definition }, headers), { params: Promise.resolve({ id: mapId }) });
  if (operation === "look") return look(request("/api/maps/look", "POST", { mapId }, headers));
  return retained(request("/api/maps/look/missing", "GET", undefined, headers), { params: Promise.resolve({ renderId: "missing" }) });
}
const state = () => ({ maps: db.prepare("SELECT * FROM maps").all(), retained: lookRetention.idsForTests(), launches: vi.mocked(renderMapImage).mock.calls.length });
for (const operation of ["image", "look", "retained"]) {
  it.each(["anonymous", "invalid", "revoked-cookie", "revoked-token", "deactivated"])(`${operation} refuses %s before private work`, async mode => {
    let headers: Record<string, string> = {};
    if (mode === "invalid") headers = { authorization: "Bearer invalid", "x-dezfil-account-id": signed.account.id };
    if (mode === "revoked-cookie") { headers = cookie(); signOut(authenticateSession(signed.secret, db)!, db); }
    if (mode === "revoked-token") { headers = bearer(); revokeApiToken(authenticateSession(signed.secret, db)!, token.id, db); }
    if (mode === "deactivated") { headers = bearer(); db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(signed.account.id); }
    const before = state(), response = await invoke(operation, headers);
    expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ error: { code: "authentication_required" } });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(state()).toEqual(before);
  });
}
it.each(["image", "look"])("%s refuses a foreign cookie origin without rendering", async operation => {
  const before = state(), response = await invoke(operation, { ...cookie(), origin: "https://unrelated.test" });
  expect(response.status).toBe(403); expect(state()).toEqual(before);
});
it.each(["cookie", "token"])("%s identity reaches both render paths without entering image facts or retained state", async mode => {
  const invitation = inviteAccount(authenticateSession(signed.secret, db)!, { name: "Member", email: "member@example.test" }, db);
  signed = await redeemSignInLink(invitation.secret, "field notebooks at dawn", db);
  token = createApiToken(authenticateSession(signed.secret, db)!, "Member render", db);
  const headers = mode === "cookie" ? cookie() : bearer();
  for (const operation of ["image", "look"]) expect((await invoke(operation, headers)).status).toBe(404);
  expect(renderMapImage).not.toHaveBeenCalled();
  mapId = createMap(accountScope(authenticateSession(signed.secret, db)!, db), "Member image").id;
  for (const operation of ["image", "look"]) {
    const response = await invoke(operation, headers); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const input = vi.mocked(renderMapImage).mock.calls.at(-1)![1] as Parameters<typeof renderMapImage>[1] & { credential?: string };
    expect(typeof input.credential).toBe("string");
    expect(authenticateDelegation(input.credential!, db)).toMatchObject({ account: { id: signed.account.id, isAdmin: false },
      credential: { kind: mode === "cookie" ? "session" : "token" } });
    expect(authenticateDelegation(input.credential!, db, Date.now() + DELEGATION_LIFETIME_MS)).toBeNull();
    expect(input.credential).not.toContain(token.secret);
    expect(input.credential).not.toContain(signed.secret);
    expect(input.baseUrl).toBe(origin);
    const responseBytes = await response.text(), facts = JSON.stringify(lookRetention.idsForTests().map(id => lookRetention.facts(accountScope(authenticateSession(signed.secret, db)!, db), id)));
    for (const value of [responseBytes, facts, JSON.stringify(input.definition), input.baseUrl]) {
      expect(value).not.toContain(token.secret); expect(value).not.toContain(signed.secret); expect(value).not.toContain("dz_delegation_");
    }
  }
  const renderId = lookRetention.idsForTests()[0];
  const response = await retained(request(`/api/maps/look/${renderId}`, "GET", undefined, headers), { params: Promise.resolve({ renderId }) });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it.each(["anonymous", "invalid", "revoked"])("the render page refuses %s before dispatch", mode => {
  let headers: Record<string, string> = mode === "anonymous" ? {} : { authorization: "Bearer invalid" };
  if (mode === "revoked") { signOut(authenticateSession(signed.secret, db)!, db); headers = cookie(); }
  const response = gateRequest(new NextRequest(request(`/render/${mapId}`, "GET", undefined, headers)));
  expect(response.headers.get("x-middleware-next")).toBeNull();
  expect(response.headers.get("location")).toBe(origin + "/sign-in"); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
