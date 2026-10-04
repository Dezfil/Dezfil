// Scratch-process controls only. No application route is added or replaced.
import fs from 'node:fs';
import path from 'node:path';
import { until } from './mcp-probe-wait.mjs';
const directory = process.env.DEZFIL_PROOF_CONTROL_DIR;
if (!directory) throw new Error('Set a scratch control directory.');
const holds = new Map(); let last;
fs.mkdirSync(directory, { recursive: true });
fs.watchFile(path.join(directory, 'request.json'), { interval: 25, persistent: false }, async () => {
  let message;
  try {
    message = JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8'));
    if (message.id === last) return; last = message.id;
    const holder = await until(() => process[Symbol.for('dezfil.account-deletion-admission')], Boolean,
      'Built application has no process-wide admission holder', 5000);
    if (message.command === 'hold') {
      if (holds.has(message.accountId)) throw new Error('Already held');
      const done = Promise.withResolvers();
      const work = { database: path.join(process.env.DEZFIL_DATA_DIR, 'metadata.sqlite'), accounts: new Set([message.accountId]), settled: done.promise, cleanups: new Set(), released: false };
      holder.work.add(work); holds.set(message.accountId, { done, work });
    } else if (message.command === 'release') {
      const held = holds.get(message.accountId); if (!held) throw new Error('No held work');
      holder.work.delete(held.work); held.work.accounts.clear(); held.work.released = true; held.done.resolve(); holds.delete(message.accountId);
    } else throw new Error('Unknown proof control');
    fs.writeFileSync(path.join(directory, 'response.json'), JSON.stringify({ id: message.id, ok: true }));
  } catch (error) {
    if (message) fs.writeFileSync(path.join(directory, 'response.json'), JSON.stringify({ id: message.id, error: error.message }));
  }
});
