import type { Database } from "better-sqlite3";
import type { AccountScope } from "@/lib/auth/scope";
import { getAccount } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import { pictureRendererAvailable } from "./renderer";

/**
 * Whether a page of map cards shows its reader the line that says map
 * pictures have no renderer: only to an administrator, the one reader who
 * can set one, and only while picture work cannot use the renderer, by the
 * same standing the System read reports as `image_renderer.available`.
 * Read as the page is served; it starts nothing and clears no refusal.
 */
export function pictureRendererNotice(scope: AccountScope, db: Database = metadataDb()): boolean {
  return getAccount(scope.accountId, db)?.isAdmin === true && !pictureRendererAvailable();
}
