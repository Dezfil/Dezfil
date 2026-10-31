import type { Database } from "better-sqlite3";
import { NextResponse } from "next/server";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { boundedBodyText } from "@/lib/api/bounded-body";
import { AuthError, requireAuthenticationWanted } from "../errors";
import { inspectSession, issueSession } from "../credentials";
import { assertRequestOrigin, authFailure, privateResponse, requestIngress, sessionCookie, sessionSecret } from "../http";
import { externalSignIn } from "./config";
import { requestStart, startCookie } from "./start";
import { invalidTicket, verifyTicket } from "./ticket";
import { resolveTicketIdentity } from "./identity";
import { addressBudget, recordAddressAttempt } from "./address-budget";

export const ARRIVAL_BODY_MAX_BYTES = 8192;
function refuseSignedIn(request: Request, db: Database, now?: number): void {
  const current = inspectSession(sessionSecret(request), db, now);
  if (current) throw new AuthError("already_signed_in", "Sign out of the current account before signing in through the sign-in service.", 409, { account: current.account });
}
async function ticketBody(request: Request): Promise<string> {
  const text = await boundedBodyText(request, ARRIVAL_BODY_MAX_BYTES, { fatal: false });
  try {
    const body = JSON.parse(text);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !body ||
      typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.ticket !== "string") throw new Error();
    return body.ticket;
  } catch { throw new AuthError("invalid_request", "Expected a JSON body containing a sign-in ticket.", 400); }
}
export async function arriveExternalSignIn(request: Request, db: Database = metadataDb(), now?: number): Promise<Response> {
  let response: Response;
  const ingress = (() => { try { return requestIngress(request); } catch { return null; } })();
  try {
    if (!externalSignIn().enabled) throw new AuthError("not_found", "External sign-in is not configured.", 404);
    if (!ingress) requestIngress(request);
    refuseSignedIn(request, db, now);
    assertRequestOrigin(request);
    let encoded: string;
    try { encoded = await ticketBody(request); }
    catch (error) {
      db.transaction(() => recordAddressAttempt(addressBudget(ingress!.source, db, now ?? Date.now()), true, db)).immediate();
      throw error;
    }
    const result = db.transaction(() => {
      const at = now ?? Date.now(); requireAuthenticationWanted(request.signal);
      refuseSignedIn(request, db, at);
      const budget = addressBudget(ingress!.source, db, at);
      let ticket, resolved;
      try {
        const generation = db.prepare("SELECT door_generation FROM auth_generations WHERE singleton=1").get() as { door_generation: number };
        ticket = verifyTicket(encoded, requestStart(request), generation.door_generation, at);
        if (db.prepare("SELECT 1 FROM auth_ticket_ids WHERE id = ?").get(ticket.jti)) throw invalidTicket();
        resolved = resolveTicketIdentity(ticket, db);
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        recordAddressAttempt(budget, true, db);
        return { error };
      }
      const { account, name, email } = resolved;
      db.prepare(`UPDATE accounts SET external_identity=?,email=?,name=?,status='active',last_sign_in_at=?,updated_at=? WHERE id=?`)
        .run(ticket.sub, email, name, new Date(at).toISOString(), new Date(at).toISOString(), account.id);
      recordAddressAttempt(budget, false, db);
      const session = issueSession(getAccount(account.id, db)!, db, at);
      db.prepare("INSERT INTO auth_ticket_ids (id, expires_at) VALUES (?, ?)").run(ticket.jti, ticket.exp * 1000);
      return { session };
    }).immediate();
    if (result.error) throw result.error;
    response = privateResponse(NextResponse.json({ account: result.session!.account }));
    sessionCookie(response as NextResponse, result.session!.secret, ingress!);
  } catch (error) { response = authFailure(error); }
  if (ingress) startCookie(response, "", ingress);
  return response;
}
