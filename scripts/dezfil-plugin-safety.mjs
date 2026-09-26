import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export function assertEvidenceWorktree(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(git('branch', '--show-current'), '', 'Evidence worktree is detached');
  assert.notEqual(realpathSync(path.resolve(root, git('rev-parse', '--git-dir'))),
    realpathSync(path.resolve(root, git('rev-parse', '--git-common-dir'))), 'Evidence runs in a linked worktree');
}
