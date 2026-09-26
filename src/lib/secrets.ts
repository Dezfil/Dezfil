import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config";

/**
 * At-rest encryption for stored credentials. The key comes from
 * DEZFIL_SECRET_KEY (64 hex chars); unset, one is generated into the
 * data directory on first boot. The stated guarantee: a copied metadata
 * database alone reveals nothing — the password never leaves the server
 * and never appears in any API response. Secret-manager integration
 * waits for the multi-user phase.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_FILE = "secret.key";

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  return path.join(dataDir(), KEY_FILE);
}

export function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.DEZFIL_SECRET_KEY;
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error(
        "DEZFIL_SECRET_KEY must be 64 hex characters (32 bytes).",
      );
    }
    cachedKey = Buffer.from(fromEnv, "hex");
    return cachedKey;
  }
  const file = keyFilePath();
  if (existsSync(file)) {
    cachedKey = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (cachedKey.length !== 32) {
      throw new Error(`The key file at ${file} is corrupt (expected 32 bytes).`);
    }
    return cachedKey;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(file, generated.toString("hex") + "\n", { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

/** Iv:tag:ciphertext, base64 fields — self-describing, versionable later. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, secretKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const [iv, tag, data] = stored.split(":");
  if (!iv || !tag || !data) {
    throw new Error("The stored secret is malformed.");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    secretKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Tests re-point DEZFIL_DATA_DIR; the cached key must not leak across. */
export function resetSecretKeyCache(): void {
  cachedKey = null;
}
