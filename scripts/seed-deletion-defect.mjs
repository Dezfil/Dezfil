// Apply only in a detached scratch checkout, then rebuild the production app.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const defects = {
  'api-self': ['src/lib/auth/account-deletion-eligibility.ts', 'if (actor.id === accountId)', 'if (false && actor.id === accountId)'],
  'api-completion': ['src/lib/auth/account-deletion-http.ts', 'NextResponse.json(value,', 'NextResponse.json({ ...value, state: "completed" },'],
  'api-confirmation': ['src/lib/api/openapi-user-deletion.ts', 'tool: "delete_user", effects, mcp: LOCAL_DELETE, confirm: true,', 'tool: "delete_user", effects, mcp: LOCAL_DELETE, confirm: false,'],
};
const [mode] = process.argv.slice(2);
assert.ok(defects[mode], `usage: node scripts/seed-deletion-defect.mjs ${Object.keys(defects).join('|')}`);
assert.equal(execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), '', 'use a detached scratch checkout');
const [file, before, after] = defects[mode];
assert.equal(execFileSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8' }).trim(), '', 'restore earlier seeds first');
const source = readFileSync(file, 'utf8'); assert.equal(source.split(before).length, 2, 'unique seed anchor');
writeFileSync(file, source.replace(before, after)); console.log(`Seeded ${mode}. Rebuild; the corresponding proof must fail.`);
