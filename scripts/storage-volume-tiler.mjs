#!/usr/bin/env node
// Delay a real tiler only when the scratch proof asks for an interleaving.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
const directory = process.env.DEZFIL_PROOF_CONTROL_DIR, binary = process.env.DEZFIL_PROOF_TILER;
if (!directory || !binary) throw new Error('The proof requires its control directory and original tiler.');
const args = process.argv.slice(2);
let child;
// Ended while paused, there is no original tiler yet: end the way an unhandled signal would.
process.on('SIGTERM', () => { if (child) child.kill('SIGTERM'); else process.exit(143); });
if (!args.includes('--version') && fs.existsSync(path.join(directory, 'tile.hold'))) {
  fs.writeFileSync(path.join(directory, 'tile.started'), JSON.stringify({ pid: process.pid }));
  while (fs.existsSync(path.join(directory, 'tile.hold'))) await pause(10);
}
child = spawn(binary, args, { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
