// Reassess retained connection evidence, optionally damaging one observation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assessArm, readRows } from './render-egress-assert.mjs';

const [directory, seed] = process.argv.slice(2);
assert.ok(directory, 'Usage: node scripts/render-egress-replay.mjs ARM_DIRECTORY [missing-netlog|dead-listener|wrong-sequence]');
assert.ok(!seed || ['missing-netlog', 'dead-listener', 'wrong-sequence'].includes(seed), 'unknown evidence seed');
try {
  const arm = JSON.parse(await readFile(path.join(directory, 'active.json'), 'utf8'));
  const evidence = {};
  for (const name of ['dns', 'listener', 'host', 'browser']) evidence[name] = readRows(await readFile(path.join(directory, `${name}.ndjson`), 'utf8'));
  evidence.result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  evidence.netlog = JSON.parse(await readFile(path.join(directory, 'netlog.json'), 'utf8'));
  if (seed === 'missing-netlog') evidence.netlog = {};
  if (seed === 'dead-listener') evidence.listener = evidence.listener.filter(row => row.phase !== 'live');
  if (seed === 'wrong-sequence') {
    const first = evidence.dns.find(row => row.phase === 'render' && row.name === arm.author && row.type === 1);
    assert.ok(first, 'no answer to mutate'); first.answers = ['192.168.99.254'];
  }
  for (const row of assessArm(arm, evidence)) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'} ${arm.id} ${row.name}${row.ok ? '' : ` ${row.message.replaceAll('\n', ' ')}`}`);
    if (!row.ok) process.exitCode = 1;
  }
} catch (error) { console.error(`FAIL missing-or-invalid-evidence ${error.message}`); process.exitCode = 1; }
