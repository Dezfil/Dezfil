import type { Database } from "better-sqlite3";
import { requireDeletingAccount } from "@/lib/metadata/account-erasure";
import { drainAssistantWork } from "./retained-work";
import { eraseLaneWork } from "@/lib/operations/lane";
import { cascadeSettled } from "@/lib/operations/cascade";
import "./runs";
import "./pending";
/** Owned jobs/runs are captured before their rows go. Initiator attribution on
 * a surviving workflow is not ownership and never expands this selection. */
export async function eraseAccountWork(accountId: string, captured: { jobs: string[]; runs: string[] }, db: Database): Promise<void> {
  db.transaction(() => requireDeletingAccount(accountId, db)).immediate();
  await Promise.all([drainAssistantWork(accountId), eraseLaneWork(captured.jobs), ...captured.runs.map(cascadeSettled)]);
}
