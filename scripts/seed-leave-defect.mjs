// Mutate only a detached scratch checkout, then build and run the same proof.
// Restore the named source before measuring the corrected candidate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const defects = {
  reach: ['src/lib/metadata/project-people.ts', '    endGrant(project.parentId, scope.accountId, db);', '    // Seed: leave the credential holder\'s grant in place.'],
  commit: ['src/lib/operations/dataset-publication.ts', '      requireInputsInReach(scope, bound, db);', '      // Seed: accept an output after its input reach ended.'],
  placement: ['src/components/ProjectsScreen.tsx', '        {!owned && (', '        {owned && ('],
  notice: ['src/components/projects/LeaveProjectDialog.tsx', '{ownsWork &&', '{false &&'],
  escape: ['src/components/projects/LeaveProjectDialog.tsx', 'if (!inFlight.current) onClose();', 'if (inFlight.current) onClose();'],
};
const [mode] = process.argv.slice(2);
assert.ok(defects[mode], 'usage: node scripts/seed-leave-defect.mjs reach|commit|placement|notice|escape');
assert.equal(execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), '', 'use a detached scratch checkout, never a working branch');
const [file, before, after] = defects[mode];
assert.equal(execFileSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8' }).trim(), '', 'restore the previous seed before applying another');
const source = readFileSync(file, 'utf8');
assert.equal(source.split(before).length, 2, 'seed anchor must occur exactly once');
writeFileSync(file, source.replace(before, after));
console.log(`Seeded ${mode} in ${file}. Rebuild this scratch checkout; its corresponding proof must fail.`);
