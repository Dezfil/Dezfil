import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { Account } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import { secretKey } from "@/lib/secrets";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { acceptAccountDeletion, type DeletionStatus } from "./account-deletion";
import { deletionEligibility } from "./account-deletion-eligibility";
import type { AuthContext } from "./credentials";
import { AuthError } from "./errors";

export interface DeletionPreview {
  account: { id: string; name: string; email: string };
  invited: boolean;
  totals: { maps: number; datasets: number; workflows: number; projects: number; connections: number; publishedLinks: number };
  people: number;
  confirmation: string;
}
export interface DeletionConfirmation { confirm?: boolean; confirmation?: string; email?: string }

/** Internal identities only. No content, resource names or roster are selected.
 * Include surviving filings in dissolved projects as well as the target's own
 * work; editing a surviving document's text does not change this inventory. */
function inventory(account: string, db: Database) {
  const args = { account };
  const ownedProjects = "SELECT id FROM projects WHERE owner_id = @account";
  const maps = db.prepare(`SELECT id, owner_id, project_id, publish_token FROM maps
    WHERE owner_id = @account OR project_id IN (${ownedProjects}) ORDER BY id`).all(args) as
    { id: string; owner_id: string; project_id: string | null; publish_token: string | null }[];
  const workflows = db.prepare(`SELECT id, owner_id, project_id FROM recipes
    WHERE owner_id = @account OR project_id IN (${ownedProjects}) ORDER BY id`).all(args) as
    { id: string; owner_id: string; project_id: string | null }[];
  const datasets = db.prepare("SELECT id FROM data_tables WHERE owner_id = @account ORDER BY id").all(args);
  const connections = db.prepare("SELECT id FROM pg_connections WHERE owner_id = @account ORDER BY id").all(args);
  const filings = db.prepare(`SELECT project_id, table_id FROM project_datasets
    WHERE table_id IN (SELECT id FROM data_tables WHERE owner_id = @account)
      OR project_id IN (${ownedProjects}) ORDER BY project_id, table_id`).all(args);
  const affectedProjects = `${ownedProjects}
    UNION SELECT project_id FROM maps WHERE owner_id = @account AND project_id IS NOT NULL
    UNION SELECT project_id FROM recipes WHERE owner_id = @account AND project_id IS NOT NULL
    UNION SELECT project_id FROM project_datasets WHERE table_id IN (SELECT id FROM data_tables WHERE owner_id = @account)`;
  const projects = db.prepare(`SELECT p.id, p.owner_id, a.status FROM projects p JOIN accounts a ON a.id = p.owner_id
    WHERE p.id IN (${affectedProjects}) ORDER BY p.id`).all(args) as { id: string; owner_id: string; status: string }[];
  const grants = db.prepare(`SELECT pp.project_id, pp.account_id, pp.role, a.status FROM project_people pp
    JOIN accounts a ON a.id = pp.account_id WHERE pp.project_id IN (${affectedProjects}) OR pp.account_id = @account
    ORDER BY pp.project_id, pp.account_id`).all(args) as { project_id: string; account_id: string; role: string; status: string }[];
  const available = new Set(projects.filter(p => !["deleting", "deleted"].includes(p.status)).map(p => p.id));
  const people = new Set(projects.filter(p => p.status === "active").map(p => p.owner_id));
  for (const grant of grants) if (available.has(grant.project_id) && grant.status === "active") people.add(grant.account_id);
  people.delete(account);
  const ownedMaps = maps.filter(row => row.owner_id === account);
  return { facts: { maps, workflows, datasets, connections, filings, projects, grants }, people: people.size,
    totals: { maps: ownedMaps.length, datasets: datasets.length, workflows: workflows.filter(row => row.owner_id === account).length,
      projects: projects.filter(row => row.owner_id === account).length, connections: connections.length,
      publishedLinks: ownedMaps.filter(row => row.publish_token !== null).length } };
}

function snapshot(account: Account, actorId: string, db: Database): DeletionPreview {
  const { facts, totals, people } = inventory(account.id, db);
  // A stateless MAC carries no private references and creates no retained
  // preview store. The domain separates it from every other use of the key.
  const confirmation = createHmac("sha256", secretKey()).update(JSON.stringify({
    purpose: "account-deletion-preview-v1", actorId, accountId: account.id,
    generation: account.updatedAt, status: account.status, lastSignInAt: account.lastSignInAt,
    email: account.email, facts,
  })).digest("hex");
  return { account: { id: account.id, name: account.name, email: account.email },
    invited: account.lastSignInAt === null, totals, people, confirmation };
}

export function previewAccountDeletion(context: AuthContext, accountId: string, db: Database = metadataDb()): DeletionPreview | DeletionStatus {
  return db.transaction(() => {
    const { actor, account, pending } = deletionEligibility(context, accountId, db);
    return pending ? { id: pending.id, state: pending.state } : snapshot(account!, actor.id, db);
  })();
}

/** No journal, accepted state or cleanup is created before this callback
 * succeeds under the coordinator's immediate acceptance transaction. */
export function confirmAccountDeletion(context: AuthContext, accountId: string, input: DeletionConfirmation,
  db: Database = metadataDb()): DeletionStatus {
  return acceptAccountDeletion(context, accountId, () => {
    const current = previewAccountDeletion(context, accountId, db) as DeletionPreview;
    if (input.confirm !== true || typeof input.confirmation !== "string" || !/^[a-f0-9]{64}$/.test(input.confirmation) ||
        !current.invited && input.email !== current.account.email) {
      throw new AuthError("invalid_request", "Confirm deletion and enter the account's exact email address when required.", 400);
    }
    if (!timingSafeEqual(Buffer.from(input.confirmation, "hex"), Buffer.from(current.confirmation, "hex"))) {
      throw new AuthError("deletion_changed", ERROR_CATALOGUE.deletion_changed, 409);
    }
  }, db);
}
