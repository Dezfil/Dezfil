#!/usr/bin/env node
// Hold the real tiler alive on its real input only when the scratch proof asks for an interleaving.
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
const directory = process.env.DEZFIL_PROOF_CONTROL_DIR, binary = process.env.DEZFIL_PROOF_TILER;
if (!directory || !binary) throw new Error('The proof requires its control directory and original tiler.');
const args = process.argv.slice(2), hold = path.join(directory, 'tile.hold');
const held = !args.includes('--version') && fs.existsSync(hold);
// The input's end is what stays held: the tiler has opened its output and is
// blocked reading a pipe, as it would be on a slow disk. Ending it here ends the real process.
const child = held
  ? spawn(binary, args.slice(0, -1), { stdio: ['pipe', 'inherit', 'inherit'] })
  : spawn(binary, args, { stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
if (held) {
  await once(child, 'spawn');
  child.stdin.on('error', () => {}); // The stop that ends the tiler also breaks this pipe.
  const input = fs.readFileSync(args.at(-1)), lastLine = input.lastIndexOf(10, input.length - 2) + 1;
  child.stdin.write(input.subarray(0, lastLine));
  const running = () => child.exitCode === null && child.signalCode === null;
  while (running() && !fs.existsSync(args[args.indexOf('-o') + 1])) await pause(10);
  fs.writeFileSync(path.join(directory, 'tile.started'), JSON.stringify({ pid: process.pid, tiler: child.pid, binary }));
  while (running() && fs.existsSync(hold)) await pause(10);
  child.stdin.end(input.subarray(lastLine));
}
