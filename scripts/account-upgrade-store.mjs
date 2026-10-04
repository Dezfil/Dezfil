import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

// SQLite's backup runs beside the server so WAL locks never cross a host file
// share. The host inspects only the completed, closed copy, at each checkpoint.
const snapshotScript = `
  const Database = require('better-sqlite3');
  const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
  db.backup(process.argv[2]).then(() => db.close(), error => {
    db.close(); console.error(error); process.exitCode = 1;
  });
`;

export async function withUpgradeStore({ directory, scratch, container, docker }, inspect) {
  let snapshot, remote, db;
  try {
    let file = path.join(directory, 'metadata.sqlite');
    if (container) {
      snapshot = await mkdtemp(path.join(scratch, 'inspection-'));
      remote = `/tmp/${path.basename(snapshot)}.sqlite`;
      docker('exec', container, 'node', '-e', snapshotScript, '/data/metadata.sqlite', remote);
      file = path.join(snapshot, 'metadata.sqlite');
      docker('cp', `${container}:${remote}`, file);
    }
    db = new Database(file, { readonly: true, fileMustExist: true });
    return await inspect(db);
  } finally {
    db?.close();
    try {
      if (remote) docker('exec', container, 'node', '-e', "require('node:fs').rmSync(process.argv[1], { force: true })", remote);
    } finally { if (snapshot) await rm(snapshot, { recursive: true, force: true }); }
  }
}
