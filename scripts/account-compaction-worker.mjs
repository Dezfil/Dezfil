// A proof-only HTTP process: the production module runs with its real store
// held open, so an outside process observes its synchronous health pause.
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { compactMetadataStore } from '../src/lib/metadata/account-compaction.mjs';
import { liveFixture } from './account-compaction-fixture.mjs';
const [mode, directory, portText, seed] = process.argv.slice(2), port = Number(portText);
if (!Number.isInteger(port) || port < 3300) throw new Error('Use an owned non-default proof port');
const fixture = mode === 'bytes' ? liveFixture(directory, seed) : null;
const db = fixture?.db ?? new Database(`${directory}/metadata.sqlite`);
db.pragma('foreign_keys = ON');
let reader;
function compact() {
      const started = performance.now();
      if (seed === 'pause') { const until = performance.now() + 5100; while (performance.now() < until) { /* Seed an uninterrupted pause. */ } }
      let measured;
      if (seed !== 'row-only') measured = compactMetadataStore(db);
      return { ok: true, measured, intervalMs: performance.now() - started, open: db.open,
        journal: db.pragma('journal_mode', { simple: true }), tempStore: db.pragma('temp_store', { simple: true }),
        compileOptions: db.pragma('compile_options') };

}
process.on('message', message => {
  if (!message.compact) return;
  let result;
  try { result = compact(); }
  catch (error) {
    result = seed === 'busy-success' || seed === 'space-success' ? { ok: true, swallowed: error.message } : { ok: false, code: error.code, message: error.message };
  }
  process.send({ compaction: result });
});
process.on('disconnect', () => { reader?.close(); db.close(); process.exit(1); });
const server = createServer((request, response) => {
  let result;
  try {
    if (request.url === '/health') result = { healthy: true };
    else if (request.url === '/integrity') result = { integrity: db.pragma('integrity_check', { simple: true }) };
    else if (request.url === '/hold') {
      reader = new Database(db.name, { readonly: true }); reader.exec('BEGIN'); reader.prepare('SELECT * FROM accounts').all(); result = { held: true };
    } else if (request.url === '/release') { reader.exec('ROLLBACK'); reader.close(); reader = undefined; result = { released: true }; }
    else if (request.url === '/erase') { fixture.erase(); result = fixture.scan(); }
    else if (request.url === '/scan') result = fixture.scan();
    else if (request.url === '/compact') {
      result = compact();
    } else { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  } catch (error) {
    result = seed === 'busy-success' || seed === 'space-success' ? { ok: true, swallowed: error.message } : { ok: false, code: error.code, message: error.message };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, pid: process.pid, port, target: fixture?.target, control: fixture?.control })));
process.on('SIGTERM', () => { reader?.close(); server.close(() => { db.close(); process.exit(0); }); });
