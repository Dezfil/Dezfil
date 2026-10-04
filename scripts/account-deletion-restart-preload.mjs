// IPC belongs to the proof parent only. No route or tool exposes deletion.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { productLoader } from './account-deletion-source-loader.mjs';
const directory = process.env.DEZFIL_DATA_DIR;
const load = productLoader();
let killAt;
const rename = fs.renameSync;
fs.renameSync = function(source, target) {
  const result = rename.call(this, source, target);
  if (String(target).includes('/account-deletions/') && String(target).endsWith('.json')) {
    const journal = JSON.parse(fs.readFileSync(target, 'utf8'));
    const expected = { rows: 4, files: 6, compaction: 10, removal: 11 }[killAt];
    if (expected === journal.next) process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
syncBuiltinESMExports();
// Named defect: lose accepted work before production startup discovers it.
if (process.env.DEZFIL_PROOF_LOSE_JOURNAL === '1') fs.rmSync(path.join(directory, 'account-deletions'), { recursive: true, force: true });
process.on('message', async message => {
  if (!message || !['accept', 'finish', 'status'].includes(message.command)) return;
  try {
    const service = load('lib/auth/account-deletion.ts');
    const { authenticateSession } = load('lib/auth/credentials.ts');
    const actor = authenticateSession(message.secret);
    if (!actor) throw new Error('Proof credential rejected');
    let value;
    if (message.command === 'accept') value = service.acceptAccountDeletion(actor, message.accountId, () => {});
    else if (message.command === 'finish') { killAt = message.killAt; value = await service.finishAccountDeletion(actor, message.id); }
    else value = service.pendingAccountDeletion(message.accountId);
    process.send?.({ requestId: message.requestId, value });
  } catch (error) { process.send?.({ requestId: message.requestId, error: error.stack }); }
});
