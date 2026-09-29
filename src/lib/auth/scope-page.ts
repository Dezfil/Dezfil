import type { Database } from "better-sqlite3";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { accountCount } from "@/lib/metadata/accounts";
import { AuthError } from "./errors";
import { requestIngress } from "./http";
import { requireRequestScope } from "./scope-http";
import type { AccountScope } from "./scope";

/** Server pages reauthenticate, even when the request passed the early gate. */
export async function requirePageScope(db?: Database): Promise<AccountScope> {
  const incoming = new Headers(await headers());
  const ingress = requestIngress({ headers: incoming });
  try {
    return requireRequestScope(new Request(ingress.origin, { headers: incoming }), db);
  } catch (error) {
    if (error instanceof AuthError && error.code === "authentication_required") {
      redirect(accountCount(db) === 0 ? "/setup" : "/sign-in");
    }
    throw error;
  }
}
