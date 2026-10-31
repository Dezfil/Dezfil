import { randomUUID, createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { open } from "../src/lib/metadata/db";
import { insertAccount } from "../src/lib/metadata/accounts";
import { eraseAccountCredentials } from "../src/lib/metadata/account-erasure";
import { eraseAccountContent } from "../src/lib/metadata/account-erasure-content";

/** Values are independent of SQL names, retained identities and copies. Every
 * planted value must be found before it can count as absent after compaction. */
export function compactionFixture() {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "live-bytes-"));
  const file = path.join(directory, "metadata.sqlite"), db = open(file);
  db.pragma("wal_autocheckpoint = 0"); db.pragma("secure_delete = OFF");
  const value = (kind: string) => `${kind}-${randomUUID()}-sentinel`;
  const target = [value("former-email"), value("former-name"), value("former-password"), value("current-email"), value("current-name"), value("current-password"), value("session-secret-hash"), value("token-secret-hash"), value("link-secret-hash"), value("content")];
  const control = [value("control-email"), value("control-name"), value("control-password"), value("control-content")];
  for (const id of ["target", "control"]) insertAccount({ id, name: `reserved-${id}`, email: `${id}@example.test`, passwordHash: null, status: "active", isAdmin: false, now: "time" }, db);
  db.prepare("UPDATE accounts SET email = ?, name = ?, password_hash = ? WHERE id = 'target'").run(...target.slice(0, 3));
  db.prepare("UPDATE accounts SET email = ?, name = ?, password_hash = ? WHERE id = 'control'").run(...control.slice(0, 3));
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.prepare("UPDATE accounts SET email = ?, name = ?, password_hash = ? WHERE id = 'target'").run(...target.slice(3, 6));
  const scan = () => {
    const bytes = readdirSync(directory).map(name => readFileSync(path.join(directory, name)));
    const found = (values: string[]) => values.filter(s => bytes.some(b => b.includes(Buffer.from(s))));
    return { target: found(target), control: found(control) };
  };
  const formerImmediately = scan().target.slice(0, 3);
  db.prepare("INSERT INTO auth_sessions (id,secret_hash,account_id,created_at,expires_at,last_used_at,revoked_at) VALUES ('session', ?, 'target', 1, 2, 1, NULL)").run(target[6]);
  db.prepare("INSERT INTO auth_tokens (id,account_id,name,secret_hash,created_at,last_used_at,revoked_at,expires_at) VALUES ('token', 'target', 'token', ?, 1, NULL, 2, NULL)").run(target[7]);
  db.prepare("INSERT INTO auth_links VALUES ('link', 'target', 'reset', ?, 1, 2, 2, NULL)").run(target[8]);
  for (const [id, content] of [["target", target[9]], ["control", control[3]]]) {
    db.prepare("INSERT INTO account_preferences VALUES (?, ?, 'time')").run(id, content.repeat(2000));
    const cipher = createCipheriv("aes-256-gcm", randomBytes(32), randomBytes(12));
    const envelope = Buffer.concat([cipher.update(content), cipher.final(), cipher.getAuthTag()]).toString("base64");
    (id === "target" ? target : control).push(envelope);
    db.prepare(`INSERT INTO pg_connections (id,name,host,port,database,username,password_encrypted,created_at,owner_id)
      VALUES (?, 'same connection', 'localhost', 5432, 'gis', 'user', ?, 'time', ?)`).run(id, envelope, id);
    const keyEnvelope = `${envelope}-assistant-key`;
    (id === "target" ? target : control).push(keyEnvelope);
    db.prepare("INSERT INTO assistant_keys VALUES (?, 'openai', ?, 'f00d', 1)").run(id, keyEnvelope);
  }
  return { db, directory, file, target, control, formerImmediately, scan,
    erase() {
      db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
      eraseAccountCredentials("target", db); eraseAccountContent("target", db);
      // Fixture finalization only. The public coordinator will journal pending
      // reservations before stripping this profile and declaring completion.
      db.exec(`UPDATE accounts SET status = 'deleted', name = NULL, email = NULL, password_hash = NULL,
        is_admin = NULL, created_at = NULL, updated_at = NULL, last_sign_in_at = NULL WHERE id = 'target'`);
    },
    dispose() { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
