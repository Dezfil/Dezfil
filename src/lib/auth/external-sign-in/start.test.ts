import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { makeStart, readStart, requestStart, startCookieName, startExternalSignIn, START_LIFETIME_MS } from "./start";
const restart = () => Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in-start-key"));
function configured() {
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!);
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", "instance"); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_URL", "https://door.example/sign-in?app=maps");
}
const request = (origin = "https://instance.test") => socketRequest(new Request(`${origin}/api/auth/external/start`, { method: "POST", headers: { origin } }));
afterEach(() => { vi.unstubAllEnvs(); restart(); Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in")); });
it("binds an unguessable start to a signed cookie for exactly ten minutes and loses it at restart", () => {
  const start = makeStart(1000);
  expect(readStart(start.cookie, 1000)).toBe(start.value);
  expect(readStart(start.cookie, 1000 + START_LIFETIME_MS - 1)).toBe(start.value);
  expect(readStart(start.cookie, 1000 + START_LIFETIME_MS)).toBeNull();
  expect(readStart(start.cookie + "x", 1000)).toBeNull(); expect(readStart(null, 1000)).toBeNull();
  restart(); expect(readStart(start.cookie, 1000)).toBeNull();
});
it.each(["http://instance.test", "https://instance.test"])("redirects with the start and sets a host-only cookie using trusted transport at %s", origin => {
  configured(); vi.stubEnv("PORT", "3399");
  const response = startExternalSignIn(request(origin));
  expect(response.status).toBe(303); const destination = new URL(response.headers.get("location")!);
  expect(destination.origin).toBe("https://door.example"); expect(destination.searchParams.get("app")).toBe("maps");
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("dezfil_session_3399_start="); expect(cookie).toContain("HttpOnly; SameSite=Lax; Max-Age=600");
  expect(cookie.includes("; Secure")).toBe(origin.startsWith("https:")); expect(cookie).not.toContain("Domain=");
  expect(readStart(cookie.split(";")[0].split("=")[1])).toBe(destination.searchParams.get("start"));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("refuses cross-origin starts and ambiguous cookies", () => {
  configured(); const input = request(); input.headers.set("origin", "https://elsewhere.example");
  expect(startExternalSignIn(input).status).toBe(403);
  const name = startCookieName(); input.headers.set("cookie", `${name}=one; ${name}=two`); expect(requestStart(input)).toBeNull();
});
it("ten thousand concurrent abandoned starts across a restart retain no rows", async () => {
  // Its own store: it compares every table, and other test files write to the shared one meanwhile.
  const shared = process.env.DEZFIL_DATA_DIR!, own = mkdtempSync(path.join(shared, "abandoned-starts-"));
  closeMetadataDb(); process.env.DEZFIL_DATA_DIR = own;
  configured(); const db = metadataDb();
  const snapshot = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all());
  try {
    const before = snapshot();
    for (let half = 0; half < 2; half++) {
      const responses = await Promise.all(Array.from({ length: 5000 }, () => Promise.resolve(startExternalSignIn(request()))));
      expect(responses.every(response => response.status === 303)).toBe(true); restart();
    }
    expect(snapshot()).toEqual(before);
  } finally { closeMetadataDb(); process.env.DEZFIL_DATA_DIR = shared; rmSync(own, { recursive: true, force: true }); }
});
