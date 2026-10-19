import { pictureRequestScope } from "@/lib/pictures/credential";
import { requestIngress } from "./http";
import type { Database } from "better-sqlite3";
import { accountScope, type AccountScope } from "./scope";
import { requireRequestAuth } from "./http";

export function requireRequestScope(request: Request, db?: Database): AccountScope {
  requestIngress(request);
  const picture = pictureRequestScope(request, db);
  if (picture) return picture;
  return accountScope(requireRequestAuth(request, db), db);
}
