import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { socketRequest } from "./socket-request";
import type { EditBasis } from "@/lib/edit-basis";
import { fixtureHeaders } from "../../../../scripts/revision-fixtures.mjs";

export const TEST_ACCOUNT_ID = "test-account";
const credentials = new WeakMap<Database, string>();
/** The Request each caller's Request was dispatched as. The derived one's
 * signal follows the caller's through a weakly held link, so nothing but
 * this keeps it alive once the route has returned: a full collection then
 * would cut the link, and a departure would never reach the route. It lives
 * as long as the caller's Request does. */
const dispatched = new WeakMap<Request, Request>();

/** A real account credential for existing route fixtures. No auth service is mocked. */
export function authenticatedRequest(request = new Request("http://127.0.0.1:3000/api/assistant/runs", { method: "POST" }), basis?: EditBasis): Request {
  if (!process.env.DEZFIL_DATA_DIR) throw new Error("Authenticated fixtures require a scratch DEZFIL_DATA_DIR");
  const headers = new Headers(fixtureHeaders(basis, request.headers));
  if (!headers.has("authorization") && !headers.has("cookie")) {
    const db = metadataDb();
    let secret = credentials.get(db);
    if (!secret) {
      secret = db.transaction(() => {
        testAccountScope(db, TEST_ACCOUNT_ID);
        db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(TEST_ACCOUNT_ID);
        const account = getAccount(TEST_ACCOUNT_ID, db)!;
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
  const derived = socketRequest(request);
  dispatched.set(request, derived);
  return derived;
}

export function authenticatedRoute<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return (request: Request = new Request("http://127.0.0.1:3000/api/assistant/runs", { method: "POST" }), ...args: Args) => handler(authenticatedRequest(request), ...args);
}
