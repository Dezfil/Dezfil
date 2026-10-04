import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount, insertAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetSecretKeyCache } from "@/lib/secrets";
import { readMap } from "@/lib/map-service";
import { authenticateSession, issueSession, type AuthContext } from "./credentials";
import { changeAccountAccess } from "./admin";
import { previewAccountDeletion, confirmAccountDeletion, type DeletionPreview } from "./account-deletion-preview";

const root = process.env.DEZFIL_DATA_DIR!;
let directory: string, admin: AuthContext;
beforeEach(() => {
  directory = mkdtempSync(path.join(root, "preview-")); process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb(); resetSecretKeyCache();
  for (const id of ["target", "admin", "member", "outsider", "inactive"]) testAccountScope(undefined, id);
  const db = metadataDb();
  db.exec("UPDATE accounts SET last_sign_in_at='time'; UPDATE accounts SET is_admin=1 WHERE id='admin'; UPDATE accounts SET status='deactivated' WHERE id='inactive'");
  admin = authenticateSession(issueSession(getAccount("admin")!, db, Date.now()).secret)!;
  db.exec(`INSERT INTO projects(id,name,created_at,updated_at,owner_id) VALUES
    ('private-project','Private project sentinel','time','time','target'),
    ('foreign-project','Foreign project sentinel','time','time','outsider');
    INSERT INTO maps(id,name,created_at,updated_at,owner_id,project_id,publish_token) VALUES
    ('private-map','Private map sentinel','time','time','target','foreign-project','private-link'),
    ('survivor','Surviving member sentinel','time','time','member','private-project',NULL);
    INSERT INTO recipes(id,name,created_at,updated_at,owner_id) VALUES ('workflow','Private workflow sentinel','time','time','target');
    INSERT INTO data_tables(id,name,format,file,row_count,created_at,owner_id) VALUES
    ('dataset','private_dataset_sentinel','parquet','tables/private.parquet',0,'time','target');
    INSERT INTO pg_connections(id,name,host,port,database,username,password_encrypted,created_at,owner_id) VALUES
    ('connection','Private connection sentinel','secret-host',5432,'private','private','secret','time','target');
    INSERT INTO project_people(project_id,account_id,role,added_at) VALUES
    ('private-project','member','viewer','time'),('private-project','inactive','viewer','time'),
    ('foreign-project','member','editor','time'),('foreign-project','target','viewer','time');
    INSERT INTO project_datasets(project_id,table_id,added_at) VALUES
    ('private-project','dataset','time'),('foreign-project','dataset','time');`);
  changeAccountAccess(admin, "target", { status: "deactivated" });
});
afterEach(() => { closeMetadataDb(); resetSecretKeyCache(); process.env.DEZFIL_DATA_DIR = root; rmSync(directory, { recursive: true, force: true }); });
function preview() { return previewAccountDeletion(admin, "target") as DeletionPreview; }
const confirm = (value: DeletionPreview, email = value.account.email) => confirmAccountDeletion(admin, value.account.id, { confirm: true, confirmation: value.confirmation, email });
const listing = () => readdirSync(directory, { recursive: true }).sort();
function unchangedRefusal(action: () => unknown, code: string) {
  const db = metadataDb(), rows = db.prepare("SELECT * FROM accounts ORDER BY id").all(), files = listing();
  expect(action).toThrow(expect.objectContaining({ code }));
  expect(db.prepare("SELECT * FROM accounts ORDER BY id").all()).toEqual(rows);
  expect(listing()).toEqual(files);
  expect(db.prepare("SELECT count(*) AS n FROM maps").get()).toEqual({ n: 2 });
}

it("returns only the Users identity, owned totals once each and distinct active people losing reach", () => {
  const result = preview();
  expect(result).toEqual({ account: { id: "target", name: "target", email: "target@example.test" }, invited: false,
    totals: { maps: 1, datasets: 1, workflows: 1, projects: 1, connections: 1, publishedLinks: 1 }, people: 2, confirmation: expect.stringMatching(/^[a-f0-9]{64}$/) });
  // Positive controls use ordinary reach, not privileged SQL reads.
  expect(readMap(testAccountScope(undefined, "outsider"), "private-map").name).toBe("Private map sentinel");
  expect(readMap(testAccountScope(undefined, "member"), "survivor").name).toBe("Surviving member sentinel");
  const wire = JSON.stringify(result);
  for (const forbidden of ["sentinel", "private-project", "private-map", "private-link", "member", "outsider", "sqlName", "secret-host"]) expect(wire).not.toContain(forbidden);
});
it("includes people who lose surviving member work through dissolution and deduplicates overlapping grants", () => {
  const db = metadataDb();
  db.exec("DELETE FROM maps WHERE id='private-map'; DELETE FROM project_datasets; DELETE FROM project_people WHERE project_id='foreign-project'");
  expect(preview().people).toBe(1);
  db.exec("INSERT INTO project_people(project_id,account_id,role,added_at) VALUES ('private-project','outsider','viewer','time')");
  expect(preview().people).toBe(2);
});
it.each([
  ["same-count swap", "UPDATE maps SET id='replacement' WHERE id='private-map'"],
  ["publication revoked", "UPDATE maps SET publish_token=NULL WHERE id='private-map'"],
  ["publication replaced", "UPDATE maps SET publish_token='new-link' WHERE id='private-map'"],
  ["member swap", "UPDATE project_people SET account_id='admin' WHERE project_id='private-project' AND account_id='member'"],
  ["filing removed", "UPDATE maps SET project_id=NULL WHERE id='survivor'"],
] as const)("refuses a stale %s without a journal or any destructive effects", (_name, sql) => {
  const value = preview(); metadataDb().exec(sql); unchangedRefusal(() => confirm(value), "deletion_changed");
});
it("invalidates a reactivate/deactivate cycle even in one millisecond", () => {
  const value = preview(), now = Date.parse(getAccount("target")!.updatedAt);
  changeAccountAccess(admin, "target", { status: "active" }, metadataDb(), now);
  changeAccountAccess(admin, "target", { status: "deactivated" }, metadataDb(), now);
  unchangedRefusal(() => confirm(value), "deletion_changed");
});
it("does not invalidate an unrelated edit to a surviving document", () => {
  const value = preview(); metadataDb().exec("UPDATE maps SET name='Changed title',edit_revision=edit_revision+1 WHERE id='survivor'");
  expect(confirm(value)).toMatchObject({ state: "pending" });
});
it.each([undefined, "", "TARGET@example.test", "target@example.test ", "outsider@example.test"])("refuses a missing or mistyped email %s without effects", email => {
  const value = preview(); unchangedRefusal(() => confirmAccountDeletion(admin, "target", { confirm: true, confirmation: value.confirmation, email }), "invalid_request");
});
it("binds confirmation to the requesting admin and refuses forged or absent confirmation", () => {
  const value = preview(); metadataDb().exec("UPDATE accounts SET is_admin=1 WHERE id='outsider'");
  const other = authenticateSession(issueSession(getAccount("outsider")!, metadataDb(), Date.now()).secret)!;
  unchangedRefusal(() => confirmAccountDeletion(other, "target", { confirm: true, confirmation: value.confirmation, email: value.account.email }), "deletion_changed");
  unchangedRefusal(() => confirmAccountDeletion(admin, "target", { confirm: true, confirmation: "0".repeat(64), email: value.account.email }), "deletion_changed");
  unchangedRefusal(() => confirmAccountDeletion(admin, "target", { confirmation: value.confirmation, email: value.account.email }), "invalid_request");
});
it("confirms a never-used invitation explicitly without typed email and omits hidden identity fields", () => {
  insertAccount({ id: "invited", name: "Invitation", email: "invited@example.test", passwordHash: null, isAdmin: false, status: "invited", now: new Date().toISOString() });
  const value = previewAccountDeletion(admin, "invited") as DeletionPreview;
  expect(value.invited).toBe(true); expect(Object.values(value.totals)).toEqual([0, 0, 0, 0, 0, 0]); expect(value.people).toBe(0);
  expect(() => confirmAccountDeletion(admin, "invited", { confirmation: value.confirmation })).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(confirmAccountDeletion(admin, "invited", { confirm: true, confirmation: value.confirmation })).toMatchObject({ state: "pending" });
});
it("rechecks inside the acceptance transaction and returns the same pending deletion on repetition", () => {
  const value = preview(); const accepted = confirm(value);
  expect(confirm(value)).toEqual(accepted); expect(previewAccountDeletion(admin, "target")).toEqual(accepted);
  expect(metadataDb().prepare("SELECT status FROM accounts WHERE id='target'").get()).toEqual({ status: "deleting" });
});
