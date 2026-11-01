import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, issueSession } from "./credentials";
import { getAccount } from "@/lib/metadata/accounts";
import { createMap } from "@/lib/map-service";
import { registerAccountFile } from "@/lib/ingest/file-ownership";
import * as compaction from "@/lib/metadata/account-compaction.mjs";
import * as query from "@/lib/query/account-erasure-query";
import * as credentials from "@/lib/metadata/account-erasure";
import * as content from "@/lib/metadata/account-erasure-content";
import * as projects from "@/lib/metadata/account-erasure-projects";
import * as derivatives from "./account-erasure-derivatives";
import * as providers from "./account-erasure-provider-caches";
import * as files from "@/lib/ingest/account-files";
import * as journals from "./account-deletion-journal";
import { acceptAccountDeletion, finishAccountDeletion, pendingAccountDeletion } from "./account-deletion";
import { layerDownloadTickets } from "@/lib/export/layer-download-tickets";
import { signIn } from "./accounts";
import { hashPassword } from "./passwords";
import { withStorageRecovery } from "@/lib/system/storage-reserve";
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string, actor: ReturnType<typeof authenticateSession>;
beforeEach(() => {
  directory = mkdtempSync(path.join(root, "deletion-lifecycle-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb();
  for (const id of ["target", "control", "admin"]) testAccountScope(undefined, id);
  const db = metadataDb(); db.exec("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'");
  actor = authenticateSession(issueSession(getAccount("admin")!, db, Date.now()).secret);
  createMap(testAccountScope(undefined, "target"), "Same");
  createMap(testAccountScope(undefined, "control"), "Same");
  db.exec("INSERT INTO projects(id,name,owner_id,created_at,updated_at) VALUES('target-project','Same','target','time','time'); UPDATE maps SET project_id='target-project' WHERE owner_id='control'; UPDATE accounts SET status='deactivated',last_sign_in_at='time' WHERE id='target'; UPDATE accounts SET external_identity=id||'-external',picture_version=id||'-picture' WHERE id IN ('target','control')");
  mkdirSync(path.join(directory, "tables"));
  for (const id of ["target", "control"]) { registerAccountFile(id, `tables/${id}.parquet`); writeFileSync(path.join(directory, `tables/${id}.parquet`), `${id}-file`); }
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; rmSync(directory, { recursive: true, force: true }); });
const rows = () => metadataDb().prepare("SELECT * FROM maps WHERE owner_id='control'").all();
it("discards a prepared journal on transactional refusal with an identical directory listing", () => {
  const before = readdirSync(directory, { recursive: true }).sort();
  const write = journals.writeDeletionJournal;
  vi.spyOn(journals, "writeDeletionJournal").mockImplementationOnce(journal => { write(journal); throw new Error("failed acceptance"); });
  expect(() => acceptAccountDeletion(actor!, "target", () => {})).toThrow("failed acceptance");
  expect(readdirSync(directory, { recursive: true }).sort()).toEqual(before);
  expect(getAccount("target")?.status).toBe("deactivated");
});
it.each(["credentials", "rows", "projects", "files", "derivatives", "memory", "providers", "compaction", "journal"])("keeps %s failure pending and resumes the same id without a second unfiling revision", async stage => {
  const accepted = acceptAccountDeletion(actor!, "target", () => {}), before = rows();
  const fail = () => { throw new Error("injected stage failure"); };
  const fault = stage === "credentials" ? vi.spyOn(credentials, "eraseAccountCredentials").mockImplementationOnce(fail)
    : stage === "rows" ? vi.spyOn(content, "eraseAccountContent").mockImplementationOnce(fail)
    : stage === "projects" ? vi.spyOn(projects, "dissolveAcceptedAccountProjects").mockImplementationOnce(fail)
    : stage === "derivatives" ? vi.spyOn(derivatives, "eraseAccountDerivatives").mockImplementationOnce(fail)
    : stage === "memory" ? vi.spyOn(query, "eraseAccountQueryState").mockImplementationOnce(fail)
    : stage === "providers" ? vi.spyOn(providers, "eraseProviderCaches").mockImplementationOnce(fail)
    : stage === "files" ? vi.spyOn(files, "eraseAccountFiles").mockImplementationOnce(fail)
    : stage === "compaction" ? vi.spyOn(compaction, "compactMetadataStore").mockImplementationOnce(fail)
    : vi.spyOn(journals, "removeDeletionJournal").mockImplementationOnce(fail);
  expect(await finishAccountDeletion(actor!, accepted.id)).toMatchObject({ id: accepted.id, state: "needs-retry" });
  expect(pendingAccountDeletion("target")).toMatchObject({ id: accepted.id, state: "needs-retry" });
  expect(getAccount("target")).toBeNull();
  const after = rows(), unfiled = !["credentials", "rows", "projects"].includes(stage);
  if (unfiled) { expect(after[0]).toMatchObject({ project_id: null, last_changed_by: "admin" }); expect(after).not.toEqual(before); }
  else expect(after).toEqual(before);
  fault.mockRestore(); closeMetadataDb(); journals.discoverAccountDeletions(metadataDb());
  expect(await finishAccountDeletion(actor!, accepted.id)).toEqual({ id: accepted.id, state: "completed" });
  if (unfiled) expect(rows()).toEqual(after);
  else expect(rows()[0]).toMatchObject({ project_id: null, last_changed_by: "admin" });
  expect(pendingAccountDeletion("target")).toBeNull();
  expect(readFileSync(path.join(directory, "tables/control.parquet"), "utf8")).toBe("control-file");
  expect(readdirSync(path.join(directory, "tables"))).toEqual(["control.parquet"]);
  expect(() => journals.readDeletionJournal(accepted.id)).toThrow();
  expect(metadataDb().prepare("SELECT * FROM accounts WHERE id='target'").get()).toEqual({ id: "target", sql_name: "target", status: "deleted", name: null, email: null, password_hash: null, is_admin: null, created_at: null, updated_at: null, last_sign_in_at: null, picture_version: null, external_identity: null });
  expect(getAccount("control")?.pictureVersion).toBe("control-picture");
});
it("recovers acceptance and removes readable unaccepted records and partial writes", async () => {
  const accepted = acceptAccountDeletion(actor!, "target", () => {});
  const folder = path.join(directory, "account-deletions"), journal = JSON.parse(readFileSync(path.join(folder, `${accepted.id}.json`), "utf8"));
  const orphan = { ...journal, id: "11111111-1111-4111-8111-111111111111", accountId: "control" };
  writeFileSync(path.join(folder, `${orphan.id}.json`), JSON.stringify(orphan)); writeFileSync(path.join(folder, "partial.tmp"), "partial profile");
  closeMetadataDb(); journals.discoverAccountDeletions(metadataDb());
  expect(readdirSync(folder).sort()).toEqual([`${accepted.id}.json`]);
  expect(pendingAccountDeletion("target")).toMatchObject({ id: accepted.id, state: "needs-retry" });
  expect(await finishAccountDeletion(actor!, accepted.id)).toEqual({ id: accepted.id, state: "completed" });
  expect(existsSync(folder)).toBe(false);
});
it("waits a pre-acceptance lease before deleting rows", async () => {
  const { admitAccountWork } = await import("./account-deletion-admission");
  const lease = admitAccountWork(["target"]), accepted = acceptAccountDeletion(actor!, "target", () => {});
  let done = false; const finish = finishAccountDeletion(actor!, accepted.id).then(result => { done = true; return result; });
  await new Promise(r => setImmediate(r)); expect(done).toBe(false);
  expect(metadataDb().prepare("SELECT count(*) AS n FROM maps WHERE owner_id='target'").get()).toEqual({ n: 1 });
  lease.release(); expect(await finish).toMatchObject({ state: "completed" });
});

it.each([false, true])("lets sign-in finish while deletion waits for another account's download (retry: %s)", async retry => {
  const db = metadataDb(), password = "paper cranes after midnight";
  db.prepare("UPDATE accounts SET password_hash=? WHERE id='admin'").run(await hashPassword(password));
  const scope = testAccountScope(undefined, "control");
  const binding = { layerId: "prepared-layer", format: "csv" as const };
  const prepared = path.join(directory, "prepared.csv");
  writeFileSync(prepared, "n\n1\n");
  const ticket = layerDownloadTickets.prepare(scope, binding, {
    path: prepared, filename: "prepared.csv", contentType: "text/csv", size: 4,
    cleanup: async () => { rmSync(prepared); },
  });
  const accepted = acceptAccountDeletion(actor!, "target", () => {});
  if (retry) vi.spyOn(journals, "writeDeletionJournal").mockImplementationOnce(() => {
    throw Object.assign(new Error("full journal"), { code: "ENOSPC" });
  });
  const deletion = finishAccountDeletion(actor!, accepted.id);
  let login: ReturnType<typeof signIn> | undefined;
  try {
    await vi.waitFor(() => expect(journals.readDeletionJournal(accepted.id).next).toBe(4));
    // A second recovery must also be able to acquire and release the latch
    // while deletion waits, even after deletion itself has retried a write.
    let attempts = 0;
    const recovered = withStorageRecovery(() => {
      if (!attempts++) throw Object.assign(new Error("full write"), { code: "ENOSPC" });
    });
    let signedIn = false;
    login = signIn(getAccount("admin")!.email, password, db).then(session => { signedIn = true; return session; });
    await vi.waitFor(() => expect(signedIn).toBe(true), { timeout: 2000 });
    await recovered;
    expect(journals.readDeletionJournal(accepted.id).next).toBe(4);
    expect(authenticateSession((await login).secret)?.account.id).toBe("admin");
  } finally {
    layerDownloadTickets.claim(scope, ticket, binding)!.complete();
    await deletion;
    await login;
    await layerDownloadTickets.dispose();
  }
  expect(await deletion).toMatchObject({ state: "completed" });
});

it("keeps journal and process memory obligations isolated until each deletion completes", async () => {
  const { admitAccountWork } = await import("./account-deletion-admission");
  const target = acceptAccountDeletion(actor!, "target", () => {});
  metadataDb().exec("UPDATE accounts SET status='deactivated',last_sign_in_at='time' WHERE id='control'");
  const control = acceptAccountDeletion(actor!, "control", () => {});
  const host = process as typeof process & { [key: symbol]: { prepared: Map<string, unknown>; running: Map<string, unknown> } };
  const work = host[Symbol.for("dezfil.account-deletion-continuations")];
  const keys = () => [...work.prepared.keys(), ...work.running.keys()];
  expect(keys().some(key => key.endsWith(target.id))).toBe(true); expect(keys().some(key => key.endsWith(control.id))).toBe(true);
  // Accepted accounts admit no new lease. The pre-existing prepared-copy
  // entries still populate the shared holder until actual completion.
  expect(() => admitAccountWork(["target"])).toThrow();
  await finishAccountDeletion(actor!, target.id);
  expect(keys().some(key => key.endsWith(target.id))).toBe(false); expect(keys().some(key => key.endsWith(control.id))).toBe(true);
  expect(journals.deletionJournals().map(j => j.id)).toEqual([control.id]);
  await finishAccountDeletion(actor!, control.id); expect(journals.deletionJournals()).toEqual([]);
});
it("continues the accepted actor's dissolution after that admin is deactivated", async () => {
  const accepted = acceptAccountDeletion(actor!, "target", () => {});
  metadataDb().exec("UPDATE accounts SET is_admin=1 WHERE id='control'");
  const other = authenticateSession(issueSession(getAccount("control")!, metadataDb(), Date.now()).secret)!;
  metadataDb().exec("UPDATE accounts SET status='deactivated' WHERE id='admin'");
  expect(await finishAccountDeletion(other, accepted.id)).toMatchObject({ state: "completed" });
  expect(rows()[0]).toMatchObject({ project_id: null, last_changed_by: "admin" });
});
it("does not mistake a failed file-ownership scan for an empty directory", async () => {
  const accepted = acceptAccountDeletion(actor!, "target", () => {}), bad = path.join(directory, "file-owners", "broken.json");
  writeFileSync(bad, "interrupted obligation");
  expect(await finishAccountDeletion(actor!, accepted.id)).toMatchObject({ state: "needs-retry" });
  rmSync(bad); expect(await finishAccountDeletion(actor!, accepted.id)).toMatchObject({ state: "completed" });
});

it("keeps a real reader-blocked checkpoint unfinished until the reader releases", async () => {
  const reader = new Database(path.join(directory, "metadata.sqlite"));
  reader.exec("BEGIN"); reader.prepare("SELECT name FROM accounts WHERE id='target'").get();
  const accepted = acceptAccountDeletion(actor!, "target", () => {});
  try {
    expect(await finishAccountDeletion(actor!, accepted.id)).toMatchObject({ state: "needs-retry" });
    expect(journals.readDeletionJournal(accepted.id).next).toBe(10);
    expect(pendingAccountDeletion("target")).toMatchObject({ state: "needs-retry" });
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  expect(await finishAccountDeletion(actor!, accepted.id)).toMatchObject({ state: "completed" });
});
it("replays row cleanup after a lost progress write without repeating dissolution revisions", async () => {
  const accepted = acceptAccountDeletion(actor!, "target", () => {});
  vi.spyOn(files, "eraseAccountFiles").mockRejectedValueOnce(new Error("hold after rows"));
  expect(await finishAccountDeletion(actor!, accepted.id)).toMatchObject({ state: "needs-retry" });
  const once = rows(), journal = journals.readDeletionJournal(accepted.id);
  // The process may die after a committed row transaction and before the
  // following journal rename. Resume that older durable obligation.
  journals.writeDeletionJournal({ ...journal, next: 2, state: "pending" });
  closeMetadataDb(); journals.discoverAccountDeletions(metadataDb());
  expect(await finishAccountDeletion(actor!, accepted.id)).toMatchObject({ state: "completed" });
  expect(rows()).toEqual(once);
});
