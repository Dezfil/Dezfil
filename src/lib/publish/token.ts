import { randomBytes } from "node:crypto";

/**
 * Publish tokens: random, URL-safe, and long enough to be unguessable — the
 * entire access model in a no-auth world (spec: Publish). Not sequential,
 * not derived from the map's name or id.
 */
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Documented minimum token length. 22 base-62 chars ≈ 131 bits. */
export const TOKEN_LENGTH = 22;

export function generateToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
