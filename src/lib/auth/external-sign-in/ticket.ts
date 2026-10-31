import { verify } from "node:crypto";
import { AuthError } from "../errors";
import { externalSignIn, type ExternalSignIn } from "./config";
import { readStart } from "./start";

export interface Ticket {
  aud: string; sub: string; email: string; email_verified: true; name?: string;
  iat: number; exp: number; jti: string; start: string; door_generation: number;
}
export const invalidTicket = () => new AuthError("invalid_ticket", "This sign-in ticket is invalid or expired. Start sign-in again.", 401);
function decode(part: string): Buffer {
  const bytes = Buffer.from(part, "base64url");
  if (!part || bytes.toString("base64url") !== part) throw invalidTicket();
  return bytes;
}
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Signature, claims and browser binding are checked before trusting identity.
 * Replay admission belongs to the same write transaction as session creation. */
export function verifyTicket(encoded: string, cookie: string | null, minimumGeneration: number,
  now = Date.now(), mode: ExternalSignIn = externalSignIn()): Ticket {
  try {
    if (!mode.enabled || encoded.length > 6144) throw invalidTicket();
    const parts = encoded.split(".");
    if (parts.length !== 3) throw invalidTicket();
    const header = JSON.parse(decode(parts[0]).toString("utf8"));
    if (!header || header.alg !== "EdDSA" || (header.typ !== undefined && header.typ !== "JWT") ||
      Object.keys(header).some(key => !["alg", "typ"].includes(key))) throw invalidTicket();
    const signature = decode(parts[2]);
    if (signature.length !== 64 || !mode.keys.some(key => verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature))) throw invalidTicket();
    const value = JSON.parse(decode(parts[1]).toString("utf8"));
    if (!value || value.aud !== mode.audience || !text(value.sub, 256) || !text(value.email, 320) ||
      !/^[^\s@]+@[^\s@]+$/.test(value.email) || value.email_verified !== true ||
      (value.name !== undefined && (!text(value.name, 80) || !value.name.trim())) ||
      !text(value.jti, 256) || !whole(value.iat) || !whole(value.exp) ||
      value.exp > Math.floor(Number.MAX_SAFE_INTEGER / 1000) || value.exp <= value.iat || value.exp > value.iat + 300 ||
      now < (value.iat - 60) * 1000 || now >= value.exp * 1000 ||
      !whole(value.door_generation) || value.door_generation < minimumGeneration ||
      typeof value.start !== "string" || value.start !== readStart(cookie, now)) throw invalidTicket();
    return value as Ticket;
  } catch { throw invalidTicket(); }
}
