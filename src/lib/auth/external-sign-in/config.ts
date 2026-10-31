import { createPublicKey, type KeyObject } from "node:crypto";

export interface ExternalSignIn {
  readonly enabled: boolean;
  readonly keys: readonly KeyObject[];
  readonly audience: string;
  readonly doorUrl: string;
  readonly generationFloor: number;
}

/** Raw Ed25519 public keys use unpadded base64url, with no private material. */
export function parseExternalSignIn(env: NodeJS.ProcessEnv): ExternalSignIn {
  const raw = env.DEZFIL_EXTERNAL_SIGN_IN_KEYS?.trim() ?? "";
  const audience = env.DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE?.trim() ?? "";
  if (raw && !audience) throw new Error("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE is required with DEZFIL_EXTERNAL_SIGN_IN_KEYS.");
  if (audience && !raw) throw new Error("DEZFIL_EXTERNAL_SIGN_IN_KEYS is required with DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE.");
  if (!raw) return Object.freeze({ enabled: false, keys: Object.freeze([]), audience: "", doorUrl: "", generationFloor: 0 });
  const keys = raw.split(",").map(value => {
    const key = value.trim();
    const bytes = Buffer.from(key, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== key) {
      throw new Error("DEZFIL_EXTERNAL_SIGN_IN_KEYS must contain comma-separated raw Ed25519 public keys in unpadded base64url.");
    }
    return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]), format: "der", type: "spki" });
  });
  const doorUrl = env.DEZFIL_EXTERNAL_SIGN_IN_URL?.trim() ?? "";
  try {
    const url = new URL(doorUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
  } catch { throw new Error("DEZFIL_EXTERNAL_SIGN_IN_URL must be an HTTP or HTTPS address without user information or a fragment."); }
  const floor = env.DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR?.trim() || "0";
  const generationFloor = Number(floor);
  if (!/^\d+$/.test(floor) || !Number.isSafeInteger(generationFloor)) {
    throw new Error("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR must be a non-negative safe whole number.");
  }
  return Object.freeze({ enabled: true, keys: Object.freeze(keys), audience, doorUrl, generationFloor });
}

// Share one frozen configuration across server route bundles. The startup hook
// initializes it before requests; later changes to the environment need a restart.
const key = Symbol.for("dezfil.external-sign-in");
const host = process as typeof process & { [key]?: ExternalSignIn };
export function externalSignIn(): ExternalSignIn {
  return host[key] ??= parseExternalSignIn(process.env);
}

/** Called only while the store has no account. */
export function firstOwnerConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return { id: env.DEZFIL_EXTERNAL_SIGN_IN_OWNER_ID?.trim() ?? "",
    email: env.DEZFIL_EXTERNAL_SIGN_IN_OWNER_EMAIL?.trim() ?? "",
    name: env.DEZFIL_EXTERNAL_SIGN_IN_OWNER_NAME?.trim() ?? "" };
}
