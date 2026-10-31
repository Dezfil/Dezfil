import type { Database } from "better-sqlite3";

export const LINK_LIFETIME_MS: number;
export function secretHash(secret: string): string;
export function newSecret(kind: "session" | "token" | "link"): string;
export function revokeSignInCredentials(accountId: string, db: Database, now: number,
  options?: { revokeTokens?: boolean }): { keyRemoved: boolean };
export function issueLink(accountId: string, kind: "invite" | "reset", db: Database, now: number,
  lifetimeMs?: number): { secret: string; expiresAt: number };
