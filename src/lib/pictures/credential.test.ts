import * as metadata from "@/lib/metadata/db";
import { gateRequest } from "@/lib/auth/gate";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { renderRequestHeaders } from "@/lib/export/render-credentials";
import { throughTransferGate } from "@/lib/metadata/ownership-transfer";
import { afterAll, expect, it, vi } from "vitest";
import { erasureLedger } from "../../../test-support/account-erasure-ledger";
import { implementedRoutes } from "../../../test-support/api-route-inventory";
import { authenticateBearer } from "@/lib/auth/delegation";
import { authenticateSession } from "@/lib/auth/credentials";
import { mintPictureCredential, pictureRequestScope, revokePictureCredential } from "./credential";
const f = erasureLedger();
vi.spyOn(metadata, "metadataDb").mockReturnValue(f.db);
afterAll(() => { vi.restoreAllMocks(); f.dispose(); });
const map = "target-in-target";
const request = (secret: string, path: string, method = "GET") => new Request(`http://example.test${path}`, { method, headers: { "x-dezfil-picture-work": secret } });
it("permits only the attempt map's render reads, never a bearer or session", () => {
  const credential = mintPictureCredential(map, Date.now() + 60000, f.db);
  for (const path of [`/render/${map}`, `/api/maps/${map}`, `/api/layers/layer-${map}/render`, `/api/layers/layer-${map}/tiles/0/0/0`]) {
    expect(pictureRequestScope(request(credential, path), f.db)?.accountId).toBe("target");
  }
  expect(renderRequestHeaders("https://external.test/style", "http://example.test", credential, { "x-dezfil-picture-work": credential, authorization: "old", cookie: "old" })).toEqual({});
  expect(renderRequestHeaders(`http://example.test/render/${map}`, "http://example.test", credential, {})).toEqual({ "x-dezfil-picture-work": credential });
  expect(authenticateBearer(credential, f.db)).toBeNull();
  expect(authenticateSession(credential, f.db)).toBeNull();
  for (const path of ["/api/maps/target-near-in-target", "/api/layers/layer-target-near-in-target/render", "/api/account", `/maps/${map}`, `/api/maps/${map}/thumbnail`]) {
    expect(() => pictureRequestScope(request(credential, path), f.db)).toThrow();
  }
  revokePictureCredential(credential, f.db);
  expect(() => pictureRequestScope(request(credential, `/render/${map}`), f.db)).toThrow();
});
it("refuses every implemented write through an independently discovered inventory", () => {
  const credential = mintPictureCredential(map, Date.now() + 60000, f.db);
  const writes = implementedRoutes().filter(r => !["get", "head", "options"].includes(r.method));
  expect(writes.length).toBeGreaterThan(50);
  for (const route of writes) {
    const path = route.path.replaceAll(/\{[^}]+\}/g, map);
    expect(() => pictureRequestScope(request(credential, path, route.method.toUpperCase()), f.db), `${route.method} ${path}`).toThrow();
    expect(gateRequest(socketRequest(request(credential, path, route.method.toUpperCase()))).status, `${route.method} ${path}`).toBe(401);
  }
});
it("refuses expiry, transfer, deactivation and tampering", () => {
  const credential = mintPictureCredential(map, Date.now() + 60000, f.db);
  expect(() => pictureRequestScope(request(credential + "x", `/render/${map}`), f.db)).toThrow();
  expect(() => pictureRequestScope(request(credential, `/render/${map}`), f.db, Date.now() + 60001)).toThrow();
  f.db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'target'").run();
  expect(() => pictureRequestScope(request(credential, `/render/${map}`), f.db)).toThrow();
  f.db.prepare("UPDATE accounts SET status = 'active' WHERE id = 'target'").run();
  throughTransferGate({ kind: "map", id: map, from: "target", to: "target-near" }, f.db, () => {
    f.db.prepare("UPDATE maps SET owner_id = 'target-near' WHERE id = ?").run(map);
  });
  expect(() => pictureRequestScope(request(credential, `/render/${map}`), f.db)).toThrow();
});
