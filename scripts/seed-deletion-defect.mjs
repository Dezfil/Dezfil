// Apply only in a detached scratch checkout, then rebuild the production app.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const defects = {
  'actor-unknown': ['src/components/sharing/LastChanged.tsx', 'deleted ? "Deleted account"', 'deleted ? "Unknown"'],
  'actor-tooltip': ['src/components/sharing/LastChanged.tsx', 'by an account that was deleted`', 'by Erased Person (erased_sql)`'],
  'actor-run-tooltip': ['src/components/sharing/RunInitiator.tsx', ': undefined}', ': deleted ? "Erased Person (erased_sql)" : undefined}'],
  'actor-redo': ['src/components/builder/shared-history.ts', 'const descriptions = target?.steps.map', 'const descriptions = (direction === "redo" && target?.steps.some(step => isDeletedActor(step.author)) ? undefined : target)?.steps.map'],
  'ui-placement': ['src/components/users/UserRow.tsx', 'account.status === "invited" &&', 'account.status !== "invited" &&'],
  'ui-arming': ['src/components/users/DeleteAccountDialog.tsx', '(preview.invited || email === preview.account.email)', '(preview.invited || email !== preview.account.email)'],
  'ui-completion': ['src/components/users/UsersScreen.tsx', 'if (status.state === "completed") show', 'if (status.id) show'],
  'ui-focus': ['src/components/users/UsersScreen.tsx', 'focusSearch.current = true;', 'search.current?.focus();'],
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
