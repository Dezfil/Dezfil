import type { Database } from "better-sqlite3";
import { accountScope, type AccountScope } from "./scope";
import { requireRequestAuth } from "./http";

export function requireRequestScope(request: Request, db?: Database): AccountScope {
  return accountScope(requireRequestAuth(request, db), db);
}
