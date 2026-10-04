import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function recoveryCommandLink(root, store, origin, email) {
  const args = [process.execPath, path.join(root, 'scripts/admin-recover.mjs'), '--data-dir', store, '--origin', origin, '--email', email];
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  // Like the recovery probe, give script null input while it allocates the
  // command's PTY. BSD script cannot read terminal attributes from a pipe.
  const terminal = spawnSync('script', process.platform === 'darwin' ? ['-q', '/dev/null', ...args] : ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, DEZFIL_DATA_DIR: store }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Inspect output before status so util-linux's -e preserves the same named
  // assertion for a refused recovery. Never put captured credentials in errors.
  const links = (terminal.stdout ?? '').match(/https?:\/\/[^\s]+\/accept#secret=dz_link_[\w-]+/g) ?? [];
  assert.equal(links.length, 1, 'matching recovery command issues exactly one link');
  assert.equal(terminal.status, 0, 'matching recovery command succeeds');
  return links[0];
}
