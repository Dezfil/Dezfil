import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { externalSignIn, parseExternalSignIn } from "./config";
import { readDeploymentSetting } from "@/lib/settings/deployment-read";
import { settingDefinition } from "@/lib/settings/catalogue";
const key = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
const env = { DEZFIL_EXTERNAL_SIGN_IN_KEYS: key, DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE: "instance",
  DEZFIL_EXTERNAL_SIGN_IN_URL: "https://signin.example/enter" };
afterEach(() => { vi.unstubAllEnvs(); Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in")); });
it("defaults off and refuses either half configuration by name", () => {
  expect(parseExternalSignIn({}).enabled).toBe(false);
  expect(() => parseExternalSignIn({ DEZFIL_EXTERNAL_SIGN_IN_KEYS: key })).toThrow("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE");
  expect(() => parseExternalSignIn({ DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE: "instance" })).toThrow("DEZFIL_EXTERNAL_SIGN_IN_KEYS");
});
it("freezes keys, address, audience and floor until restart", () => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const mode = externalSignIn();
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", "changed");
  expect(externalSignIn()).toBe(mode);
  expect(mode.audience).toBe("instance");
  expect(Object.isFrozen(mode)).toBe(true);
  expect(Object.isFrozen(mode.keys)).toBe(true);
});
it("refuses malformed keys, addresses and floors", () => {
  for (const patch of [{ DEZFIL_EXTERNAL_SIGN_IN_KEYS: "bad" }, { DEZFIL_EXTERNAL_SIGN_IN_URL: "" },
    { DEZFIL_EXTERNAL_SIGN_IN_URL: "https://user:password@example.org" },
    ...["-1", "0.5", "9007199254740992", "oops"].map(DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR => ({ DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR }))]) {
    expect(() => parseExternalSignIn({ ...env, ...patch })).toThrow();
  }
  expect(parseExternalSignIn({ ...env, DEZFIL_EXTERNAL_SIGN_IN_KEYS: `${key},${key}` }).keys).toHaveLength(2);
});
it("discloses a public key count without key material", () => {
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", `${key},${key}`);
  expect(readDeploymentSetting(settingDefinition("externalSignInKeys")).value).toEqual({ count: 2 });
});
