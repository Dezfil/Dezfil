import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { parseExternalSignIn } from "./config";
import { makeStart } from "./start";
import { verifyTicket } from "./ticket";
const keys = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
const mode = parseExternalSignIn({ DEZFIL_EXTERNAL_SIGN_IN_KEYS: keys.publicKey.export({ format: "jwk" }).x!,
  DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE: "instance", DEZFIL_EXTERNAL_SIGN_IN_URL: "https://door.example" });
const now = 1_800_000_000_000;
function fixture() {
  const start = makeStart(now);
  const claims = { aud: "instance", sub: "identity", email: "person@example.test", email_verified: true,
    name: "Person", iat: now / 1000, exp: now / 1000 + 300, jti: "ticket", start: start.value, door_generation: 0 };
  const encode = (payload: unknown = claims, header: unknown = { alg: "EdDSA", typ: "JWT" }, key = keys.privateKey) => {
    const content = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${content}.${sign(null, Buffer.from(content), key).toString("base64url")}`;
  };
  return { start, claims, encode };
}
afterEach(() => Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in-start-key")));
it("accepts the exact claims signed by any configured rotation key", () => {
  const f = fixture(); expect(verifyTicket(f.encode(), f.start.cookie, 0, now, mode)).toEqual(f.claims);
  expect(verifyTicket(f.encode(undefined, undefined, other.privateKey), f.start.cookie, 0, now,
    { ...mode, keys: [...mode.keys, other.publicKey] })).toEqual(f.claims);
});
it("refuses another key, tampering, unsupported algorithms and critical headers", () => {
  const f = fixture();
  for (const ticket of [f.encode(undefined, undefined, other.privateKey), f.encode().replace(/.$/, "!"),
    f.encode(undefined, { alg: "none" }), f.encode(undefined, { alg: "HS256" }),
    f.encode(undefined, { alg: "EdDSA", crit: ["unknown"] }), f.encode(undefined, { alg: "EdDSA", b64: false })]) {
    expect(() => verifyTicket(ticket, f.start.cookie, 0, now, mode)).toThrow();
  }
  const [header, , signature] = f.encode().split(".");
  const altered = Buffer.from(JSON.stringify({ ...f.claims, sub: "changed" })).toString("base64url");
  expect(() => verifyTicket(`${header}.${altered}.${signature}`, f.start.cookie, 0, now, mode)).toThrow();
});
it("refuses every missing required claim and every invalid claim boundary", () => {
  const f = fixture();
  for (const key of Object.keys(f.claims).filter(key => key !== "name")) {
    const changed = { ...f.claims } as Record<string, unknown>; delete changed[key];
    expect(() => verifyTicket(f.encode(changed), f.start.cookie, 0, now, mode), key).toThrow();
  }
  for (const patch of [{ aud: ["instance"] }, { aud: "other" }, { sub: "" }, { email: "not-email" }, { email_verified: false },
    { name: "" }, { jti: "" }, { iat: now / 1000 + 61, exp: now / 1000 + 62 }, { exp: now / 1000 },
    { exp: f.claims.iat + 301 }, { exp: f.claims.iat }, { iat: 1.5 }, { door_generation: -1 },
    { door_generation: "0" }, { door_generation: Number.MAX_SAFE_INTEGER + 1 }, { start: makeStart(now).value }]) {
    expect(() => verifyTicket(f.encode({ ...f.claims, ...patch }), f.start.cookie, 0, now, mode), JSON.stringify(patch)).toThrow();
  }
  expect(() => verifyTicket(f.encode(), f.start.cookie, 1, now, mode)).toThrow();
  expect(verifyTicket(f.encode({ ...f.claims, iat: now / 1000 + 60 }), f.start.cookie, 0, now, mode).sub).toBe("identity");
});
it("refuses a consumed (cleared), missing, foreign, expired or pre-restart browser start", () => {
  const f = fixture();
  for (const cookie of [null, "", makeStart(now).cookie]) expect(() => verifyTicket(f.encode(), cookie, 0, now, mode)).toThrow();
  const later = { ...f.claims, iat: now / 1000 + 600, exp: now / 1000 + 900 };
  expect(() => verifyTicket(f.encode(later), f.start.cookie, 0, now + 600_000, mode)).toThrow();
  Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in-start-key"));
  expect(() => verifyTicket(f.encode(), f.start.cookie, 0, now, mode)).toThrow();
});
