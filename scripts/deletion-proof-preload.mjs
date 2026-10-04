// Test-only admission and compaction holds. No HTTP endpoint exposes controls.
import fs from 'node:fs';
import { clearFixtureAttribution } from './deletion-attribution-fixture.mjs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { productLoader } from './account-deletion-source-loader.mjs';
const load = productLoader(), leases = new Map();
let failCompaction = false;
const stat = fs.statSync;
fs.statSync = function(file, ...args) {
  if (failCompaction && String(file) === path.join(process.env.DEZFIL_DATA_DIR, 'metadata.sqlite-wal')) throw new Error('Proof compaction failure');
  return stat.call(this, file, ...args);
};
syncBuiltinESMExports();
async function control(message) {
  if (message.command === 'hold') {
    if (leases.has(message.accountId)) throw new Error('Already held');
    leases.set(message.accountId, load('lib/auth/account-deletion-admission.ts').admitAccountWork([message.accountId]));
  } else if (message.command === 'release') {
    if (!leases.has(message.accountId)) throw new Error('No held lease');
    leases.get(message.accountId).release(); leases.delete(message.accountId);
  } else if (message.command === 'compaction') failCompaction = message.fail === true;
  else if (message.command === 'unknown-attribution') clearFixtureAttribution(load('lib/metadata/db.ts').metadataDb(), message);
  else throw new Error('Unknown proof control');
  return { ok: true };
}
process.on('message', async message => {
  try { process.send?.({ requestId: message.requestId, value: await control(message) }); }
  catch (error) { process.send?.({ requestId: message.requestId, error: error.stack }); }
});
// A browser runner shares only this scratch handshake, never a production route.
const directory = process.env.DEZFIL_PROOF_CONTROL_DIR;
if (directory) {
  fs.mkdirSync(directory, { recursive: true });
  const input = path.join(directory, 'request.json'), output = path.join(directory, 'response.json');
  let last;
  fs.watchFile(input, { interval: 40, persistent: false }, async () => {
    let message;
    try {
      message = JSON.parse(fs.readFileSync(input, 'utf8')); if (message.requestId === last) return; last = message.requestId;
      fs.writeFileSync(output, JSON.stringify({ requestId: last, value: await control(message) }));
    } catch (error) { if (message) fs.writeFileSync(output, JSON.stringify({ requestId: last, error: error.stack })); }
  });
}
