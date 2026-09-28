import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount, insertAccount } from "@/lib/metadata/accounts";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { socketRequest } from "./socket-request";

export const TEST_ACCOUNT_ID = "assistant-fixture-account";
const credentials = new WeakMap<Database, string>();

/** A real account credential for existing route fixtures. No auth service is mocked. */
export function authenticatedRequest(request = new Request("http://127.0.0.1:3000/api/assistant/runs", { method: "POST" })): Request {
  if (!process.env.DEZFIL_DATA_DIR) throw new Error("Authenticated fixtures require a scratch DEZFIL_DATA_DIR");
  const headers = new Headers(request.headers);
  if (!headers.has("authorization") && !headers.has("cookie")) {
    const db = metadataDb();
    let secret = credentials.get(db);
    if (!secret) {
      secret = db.transaction(() => {
        const account = getAccount(TEST_ACCOUNT_ID, db) ?? insertAccount({ id: TEST_ACCOUNT_ID, name: "Assistant fixture",
          email: "assistant-fixture@example.test", passwordHash: null, isAdmin: true, status: "active", now: new Date().toISOString() }, db);
        const session = issueSession(account, db, Date.now());
        return createApiToken(authenticateSession(session.secret, db)!, "Route fixture", db).secret;
      }).immediate();
      credentials.set(db, secret);
    }
    headers.set("authorization", `Bearer ${secret}`);
  }
  // Keep the caller's Request alive in the abort chain. Another temporary
  // Request would give undici an intermediate weak signal listener.
  headers.forEach((value, name) => request.headers.set(name, value));
  return socketRequest(request);
}

export function authenticatedRoute<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return (request: Request = new Request("http://127.0.0.1:3000/api/assistant/runs", { method: "POST" }), ...args: Args) => handler(authenticatedRequest(request), ...args);
}
