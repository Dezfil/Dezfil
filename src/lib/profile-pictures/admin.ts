import type { Database } from "better-sqlite3";
import type { Account } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { admitPictureWrite, publishPicture } from "./store";

/** An admin removes another account's picture, a deactivated one's
 * included; an account under deletion is refused as not there. The admin's
 * standing is asked at admission and again inside the commit, so an admin
 * demoted or deactivated meanwhile changes nothing. No road sets another
 * account's picture. Answers the account as it stands. */
export async function removeUserPicture(context: AuthContext, accountId: string, db: Database = metadataDb()): Promise<Account> {
  const admin = requireAdmin(context, db, Date.now());
  const write = admitPictureWrite(admin.id, accountId, db);
  try {
    return (await publishPicture(write, null, (inside) => { requireAdmin(context, inside, Date.now()); }, db)).account;
  } finally {
    write.release();
  }
}
