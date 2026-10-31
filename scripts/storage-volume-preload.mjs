// Scratch-process timing controls. The filesystem and native errors are real.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
const directory = process.env.DEZFIL_PROOF_CONTROL_DIR;
if (!directory) throw new Error('Set a scratch control directory.');
fs.mkdirSync(directory, { recursive: true });
if (process.env.SQLITE_TMPDIR) fs.mkdirSync(process.env.SQLITE_TMPDIR, { recursive: true });
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { DuckDBConnection } = require('@duckdb/node-api');
const append = (file, entry) => fs.appendFileSync(path.join(directory, file), JSON.stringify(entry) + '\n');
const original = DuckDBConnection.prototype.run;
DuckDBConnection.prototype.run = async function (sql, ...args) {
  if (/^\s*COPY\b/i.test(sql) && sql.includes('storage_probe_conversion')) {
    const writers = [...(globalThis[Symbol.for('dezfil.storage-writers')]?.writers ?? [])];
    fs.writeFileSync(path.join(directory, 'conversion.started'), JSON.stringify({ writers: writers.length }));
    while (fs.existsSync(path.join(directory, 'conversion.hold'))) {
      const stopped = writers.find(writer => writer.signal.aborted);
      if (stopped) throw stopped.signal.reason;
      await pause(10);
    }
    try { return await original.call(this, sql, ...args); }
    catch (error) { append('native-errors.ndjson', { code: error.code, message: error.message }); throw error; }
  }
  return original.call(this, sql, ...args);
};
const observed = new WeakSet(); let sequence = 0;
const timer = setInterval(() => {
  const state = globalThis[Symbol.for('dezfil.storage-writers')];
  const writers = [...(state?.writers ?? [])];
  for (const writer of writers) {
    if (observed.has(writer)) continue; observed.add(writer);
    const id = ++sequence; let abortedAt;
    writer.signal.addEventListener('abort', () => { abortedAt = performance.now(); append('writers.ndjson', { id, event: 'aborted', code: writer.signal.reason?.code }); }, { once: true });
    writer.settled.then(() => append('writers.ndjson', { id, event: 'settled', elapsedMs: abortedAt === undefined ? null : performance.now() - abortedAt }));
  }
  fs.writeFileSync(path.join(directory, 'writers.json'), JSON.stringify({ live: writers.length, fenced: state?.fenced ?? false }));
}, 10); timer.unref();
const info = console.info;
console.info = (...args) => {
  if (String(args[0]).startsWith('[storage]')) append('storage-log.ndjson', { message: String(args[0]) });
  info(...args);
};
