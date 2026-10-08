import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Load the product's current schema, not a measurement-only replacement.
const metadataUrl = new URL('../src/lib/metadata/', import.meta.url).href;
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(metadataUrl) && specifier.startsWith('./') && !path.extname(specifier)) {
    return { ...next(specifier + '.ts', context), format: 'module-typescript' };
  }
  const result = next(specifier, context);
  return result.url.startsWith(metadataUrl) && result.url.endsWith('.ts') ? { ...result, format: 'module-typescript' } : result;
} });
let MIGRATIONS, rebuildIdentities, IDENTITIES_MIGRATION, allocateSqlNames;
try {
  ({ MIGRATIONS } = await import('../src/lib/metadata/migrations.ts'));
  ({ rebuildIdentities, IDENTITIES_MIGRATION } = await import('../src/lib/metadata/migrations-identities.ts'));
  ({ allocateSqlNames } = await import('../src/lib/metadata/sql-names.ts'));
} finally { loader.deregister(); }

export function liveFixture(directory, seed) {
  mkdirSync(directory, { recursive: true }); assert.deepEqual(readdirSync(directory), [], 'fresh proof store only');
  const file = path.join(directory, 'metadata.sqlite'), db = new Database(file);
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  db.function('allocate_sql_names', { deterministic: true }, json => JSON.stringify(allocateSqlNames(JSON.parse(json))));
  for (const [i, migration] of MIGRATIONS.entries()) {
    if (migration === IDENTITIES_MIGRATION) rebuildIdentities(db, migration, i + 1);
    else db.transaction(() => { db.exec(migration); db.pragma(`user_version = ${i + 1}`); })();
  }
  db.pragma('secure_delete = OFF'); db.pragma('wal_autocheckpoint = 0');
  const sentinel = label => `${label}-${randomUUID()}-sentinel`;
  const target = ['old-email', 'old-name', 'old-password', 'email', 'name', 'password', 'session', 'token', 'link', 'envelope', 'content'].map(sentinel);
  const control = ['control-email', 'control-name', 'control-password', 'control-content'].map(sentinel);
  const encrypted = () => { const cipher = createCipheriv('aes-256-gcm', randomBytes(32), randomBytes(12));
    return Buffer.concat([cipher.update(sentinel('connection-password')), cipher.final(), cipher.getAuthTag()]).toString('base64'); };
  target[9] = encrypted(); control.push(encrypted());
  const account = db.prepare(`INSERT INTO accounts (id,name,email,password_hash,is_admin,status,created_at,updated_at,sql_name)
    VALUES (?, ?, ?, ?, 0, 'active', 'time', 'time', ?)`);
  account.run('target', target[1], target[0], target[2], 'reserved_target');
  account.run('control', control[1], control[0], control[2], 'reserved_control');
  db.exec("INSERT INTO original_account VALUES (1, 'target')");
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare("UPDATE accounts SET email = ?, name = ?, password_hash = ? WHERE id = 'target'").run(...target.slice(3, 6));
  const scan = () => {
    const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(e => e.isFile());
    const buffers = files.map(e => readFileSync(path.join(e.parentPath, e.name)));
    const found = values => values.filter(value => buffers.some(b => b.includes(Buffer.from(value))));
    return { target: found(target), control: found(control) };
  };
  if (seed === 'former-missing') { db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); }
  assert.deepEqual(scan().target, target.slice(0, 6), 'former values must be found immediately after the change in the same open store');
  db.prepare("INSERT INTO auth_sessions VALUES ('session', ?, 'target', 1, 2, 1, NULL)").run(target[6]);
  db.prepare("INSERT INTO auth_tokens VALUES ('token', 'target', 'name', ?, 1, NULL, 1, NULL)").run(target[7]);
  db.prepare("INSERT INTO auth_links VALUES ('link', 'target', 'reset', ?, 1, 2, 2, NULL)").run(target[8]);
  db.prepare(`INSERT INTO pg_connections (id,name,host,port,database,username,password_encrypted,created_at,owner_id)
    VALUES ('connection', 'name', 'localhost', 5432, 'gis', 'user', ?, 'time', 'target')`).run(target[9]);
  db.prepare(`INSERT INTO pg_connections (id,name,host,port,database,username,password_encrypted,created_at,owner_id)
    VALUES ('control-connection', 'name', 'localhost', 5432, 'gis', 'user', ?, 'time', 'control')`).run(control[4]);
  db.prepare("INSERT INTO account_preferences VALUES ('target', ?, 'time')").run(target[10].repeat(2000));
  db.prepare("INSERT INTO account_preferences VALUES ('control', ?, 'time')").run(control[3].repeat(2000));
  assert.deepEqual(scan(), { target, control }, 'every sentinel is populated');
  function erase() {
    db.transaction(() => {
      db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
      for (const table of ['auth_sessions', 'auth_tokens', 'auth_links', 'account_preferences']) db.prepare(`DELETE FROM ${table} WHERE account_id = 'target'`).run();
      db.exec("DELETE FROM pg_connections WHERE owner_id = 'target'; DELETE FROM maps WHERE owner_id = 'target'");
      db.exec(`UPDATE accounts SET status = 'deleted', name = NULL, email = NULL, password_hash = NULL,
        is_admin = NULL, created_at = NULL, updated_at = NULL, last_sign_in_at = NULL WHERE id = 'target'`);
    }).immediate();
  }
  return { db, file, directory, scan, erase, target, control };
}

export function sizedFixture(directory, mib) {
  const f = liveFixture(directory), db = f.db;
  for (const id of ['target', 'control']) db.prepare("INSERT INTO maps (id,name,created_at,updated_at,owner_id) VALUES (?, 'same', 'time', 'time', ?)").run(id, id);
  const insert = db.prepare(`INSERT INTO map_history (id,map_id,seq,scope,target_id,op,after,created_at)
    VALUES (?, ?, ?, 'map', 'map', 'update', ?, 'time')`);
  const payload = 'content-padding-'.repeat(32768), requested = mib * 1024 * 1024;
  const pageBytes = () => db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  let i = 0;
  while (pageBytes() < requested) db.transaction(() => {
    for (let n = 0; n < 4; n++, i++) insert.run(`history-${i}`, i % 4 === 0 ? 'target' : 'control', i, payload);
  })();
  const beforeBytes = pageBytes(); assert.ok(beforeBytes >= requested && beforeBytes < requested * 1.04, 'recorded metadata size');
  f.erase(); db.pragma('wal_checkpoint(TRUNCATE)');
  const pageCount = db.pragma('page_count', { simple: true }), freePages = db.pragma('freelist_count', { simple: true });
  const fraction = freePages / pageCount; assert.ok(fraction >= 0.24 && fraction <= 0.26, `25% reclaimable pages: ${fraction}`);
  db.close();
  return { file: f.file, mib, beforeBytes, pageCount, freePages, reclaimable: fraction };
}
