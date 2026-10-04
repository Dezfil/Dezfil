import type { Database } from "better-sqlite3";
import { dataDir } from "@/lib/config";
import { requireDeletingAccount } from "@/lib/metadata/account-erasure";
import { purgeProviderAnswerFiles } from "@/lib/provider-cache-generation";
export async function eraseProviderCaches(accountId: string, db: Database): Promise<void> {
  const invited = db.transaction(() => {
    const account = db.prepare("SELECT status FROM accounts WHERE id = ?").get(accountId) as { status: string } | undefined;
    if (account?.status === "invited") return true;
    requireDeletingAccount(accountId, db); return false;
  }).immediate();
  if (!invited) await purgeProviderAnswerFiles(dataDir());
}
