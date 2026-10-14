import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { accountCount, getAccount, insertAccount, markOriginalAccount } from "@/lib/metadata/accounts";
import { authenticateSession, issueSession } from "@/lib/auth/credentials";
import { accountScope, type AccountScope } from "@/lib/auth/scope";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import type { EditBasis } from "@/lib/edit-basis";
import { fixtureHeaders } from "../../../scripts/revision-fixtures.mjs";
import { SESSION_COOKIE } from "@/lib/auth/http";

/** Explicit authenticated fixture for tests that create private resources. */
export function testAccountScope(db: Database = metadataDb(), id = "test-account"): AccountScope {
  const session = testSession(db, id);
  return accountScope(authenticateSession(session.secret, db)!, db);
}

/** Route fixtures present a real credential through the ingress sanitizer. */
export function testAccountRequest(request: Request, db: Database = metadataDb(), id = "test-account", basis?: EditBasis): Request {
  const session = testSession(db, id);
  const headers = new Headers(fixtureHeaders(basis, request.headers));
  headers.set("cookie", `${SESSION_COOKIE}=${session.secret}`);
  headers.set("origin", new URL(request.url).origin);
  return socketRequest(new Request(request, { headers }));
}

function testSession(db: Database, id: string) {
  let account = getAccount(id, db);
  if (!account) {
    const first = accountCount(db) === 0;
    account = insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: null,
      status: "active", isAdmin: false, now: new Date().toISOString() }, db);
    if (first) markOriginalAccount(id, db);
  }
  return issueSession(account, db, Date.now());
}
