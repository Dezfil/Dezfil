import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AuthError, requireAuthenticationWanted } from "./errors";
import { withPasswordDerivation, type DerivationOptions } from "./derivation-admission";

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "password!", "passw0rd", "p@ssw0rd",
  "12345678", "123456789", "1234567890", "123123123", "87654321", "987654321",
  "11111111", "1111111111", "00000000", "11223344", "22222222", "33333333",
  "44444444", "55555555", "66666666", "77777777", "88888888", "99999999",
  "qwerty123", "qwertyuiop", "qazwsxedc", "asdfghjk", "asdfghjkl", "1q2w3e4r",
  "1qaz2wsx", "zaq12wsx", "abcd1234", "abc12345", "iloveyou", "admin123",
  "welcome1", "changeme", "football", "baseball", "sunshine", "princess",
  "trustno1", "whatever", "superman", "computer", "michelle", "jennifer",
  "samantha", "alexander", "liverpool", "starwars", "internet", "hello123",
  "hello1234", "secret123",
]);

/** The fewest characters any password may have: what the first account
 * takes, and the floor under the instance's shortest password. */
export const PASSWORD_FLOOR = 8;

/** The shortest length is the caller's input: the stored shortest password
 * where an instance sets one, the floor for the first account. The refusal
 * names it. */
export function validatePassword(password: string, minimum = PASSWORD_FLOOR): void {
  if (Array.from(password).length < minimum) {
    throw new AuthError("weak_password", `Use at least ${minimum} characters.`, 400);
  }
  if (COMMON_PASSWORDS.has(password.trim().toLowerCase())) {
    throw new AuthError("weak_password", "This password is too common. Choose a different one.", 400);
  }
}

// The stored parameters identify the work factor. Each derivation uses 128 MiB.
const COST = 131072;
function derive(password: string, salt: Buffer, options: DerivationOptions): Promise<Buffer> {
  return withPasswordDerivation(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: COST, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  }), options);
}

export async function hashPassword(password: string, options: DerivationOptions & { minimum?: number } = {}): Promise<string> {
  requireAuthenticationWanted(options.signal);
  validatePassword(password, options.minimum);
  const salt = randomBytes(16);
  return `scrypt$${COST}$8$1$${salt.toString("hex")}$${(await derive(password, salt, options)).toString("hex")}`;
}

// Unknown accounts still perform the same password work. The result is never accepted.
export const DUMMY_PASSWORD_HASH = `scrypt$${COST}$8$1$${"00".repeat(16)}$${"00".repeat(32)}`;

export async function verifyPassword(password: string, encoded: string, options: DerivationOptions = {}): Promise<boolean> {
  requireAuthenticationWanted(options.signal);
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== String(COST) ||
      parts[2] !== "8" || parts[3] !== "1" || !/^[a-f0-9]{32}$/.test(parts[4]) ||
      !/^[a-f0-9]{64}$/.test(parts[5])) return false;
  const actual = await derive(password, Buffer.from(parts[4], "hex"), options);
  return timingSafeEqual(actual, Buffer.from(parts[5], "hex"));
}
