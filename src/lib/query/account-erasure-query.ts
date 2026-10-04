import type { Database } from "better-sqlite3";
import { requireDeletingAccount } from "@/lib/metadata/account-erasure";
import { purgeQueryStores } from "./retained";
// Ensure the current graph's stores register even on a cold cleanup path.
import "@/lib/duckdb";
import "./catalog-state";
import "./mount-plan";
import "./views";
import "./evaluation-inputs";
import "./inflight";
import "./publication-namespace";
import "@/lib/publish/publication-resolution";
import "@/lib/geometry/service";
import "@/lib/history-admission-cache";
import "@/lib/layer-admission";
export async function eraseAccountQueryState(accountId: string, db: Database): Promise<void> {
  db.transaction(() => requireDeletingAccount(accountId, db)).immediate();
  await purgeQueryStores();
}
