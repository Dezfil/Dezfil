import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { assertEvidenceWorktree } from '../../../scripts/dezfil-plugin-safety.mjs';

it('driver accepts any detached linked worktree but rejects attached and primary checkouts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-driver-'));
  const repo = path.join(directory, 'repo'); const detached = path.join(directory, 'arbitrary-evidence-name');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  try {
    git('init', '--initial-branch=main', repo);
    git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    git('-C', repo, 'worktree', 'add', '--detach', detached);
    expect(() => assertEvidenceWorktree(detached)).not.toThrow();
    expect(() => assertEvidenceWorktree(repo)).toThrow(/detached/);
    git('-C', repo, 'checkout', '--detach');
    expect(() => assertEvidenceWorktree(repo)).toThrow(/linked worktree/);
    git('-C', detached, 'checkout', '-b', 'attached');
    expect(() => assertEvidenceWorktree(detached)).toThrow(/detached/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
