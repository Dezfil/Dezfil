// Scratch-process observers: nothing here pauses a writer or makes an error. The filesystem and native errors are real.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const directory = process.env.DEZFIL_PROOF_CONTROL_DIR;
if (!directory) throw new Error('Set a scratch control directory.');
fs.mkdirSync(directory, { recursive: true });
if (process.env.SQLITE_TMPDIR) fs.mkdirSync(process.env.SQLITE_TMPDIR, { recursive: true });
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { DuckDBConnection } = require('@duckdb/node-api');
const append = (file, entry) => fs.appendFileSync(path.join(directory, file), JSON.stringify(entry) + '\n');
// Negative control: with this set, the proof must fail at the live COPY's settlement.
if (process.env.DEZFIL_PROOF_DISABLE_INTERRUPT) DuckDBConnection.prototype.interrupt = function () {};
const original = DuckDBConnection.prototype.run;
DuckDBConnection.prototype.run = async function (sql, ...args) {
  if (/^\s*COPY\b/i.test(sql) && sql.includes('storage_probe_conversion')) {
    append('copies.ndjson', { event: 'entered', at: performance.now() });
    try {
      const answer = await original.call(this, sql, ...args);
      append('copies.ndjson', { event: 'returned', at: performance.now() });
      return answer;
    } catch (error) {
      append('copies.ndjson', { event: 'failed', at: performance.now(), message: error.message });
      append('native-errors.ndjson', { code: error.code, message: error.message });
      throw error;
    }
  }
  return original.call(this, sql, ...args);
};
const observed = new WeakSet(); let sequence = 0;
const timer = setInterval(() => {
  const state = globalThis[Symbol.for('dezfil.storage-writers')];
  const writers = [...(state?.writers ?? [])], cpu = process.cpuUsage();
  for (const writer of writers) {
    if (observed.has(writer)) continue; observed.add(writer);
    const id = ++sequence; let abortedAt;
    writer.signal.addEventListener('abort', () => { abortedAt = performance.now(); append('writers.ndjson', { id, event: 'aborted', at: abortedAt, code: writer.signal.reason?.code }); }, { once: true });
    writer.settled.then(() => append('writers.ndjson', { id, event: 'settled', elapsedMs: abortedAt === undefined ? null : performance.now() - abortedAt }));
  }
  // Written every 10 ms and read at any moment: a rename never shows the reader a half-written file.
  fs.writeFileSync(path.join(directory, 'writers.json.next'), JSON.stringify({ live: writers.length, fenced: state?.fenced ?? false, cpuMicros: cpu.user + cpu.system }));
  fs.renameSync(path.join(directory, 'writers.json.next'), path.join(directory, 'writers.json'));
}, 10); timer.unref();
const info = console.info;
console.info = (...args) => {
  if (String(args[0]).startsWith('[storage]')) append('storage-log.ndjson', { message: String(args[0]) });
  info(...args);
};
