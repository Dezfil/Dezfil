import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Command double only: the shell driver runs unchanged, without containers.
const directory = process.env.BUDGET_DRIVER_STATE;
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(join(directory, 'commands.jsonl'), `${JSON.stringify([command, ...args])}\n`);
if (command === 'sleep') process.exit(0);
if (args.includes('pg_isready')) {
  const file = join(directory, 'attempts');
  const attempt = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeFileSync(file, String(attempt + 1));
  // The initialization server answers on its socket before TCP is ready.
  if (!args.includes('-h')) process.exit(0);
  if (args[args.indexOf('-h') + 1] !== '127.0.0.1' || args[args.indexOf('-p') + 1] !== '5432') process.exit(1);
  const sequence = JSON.parse(process.env.BUDGET_DRIVER_READINESS);
  process.exit(sequence[Math.min(attempt, sequence.length - 1)]);
}
if (args.includes('--full') && process.env.BUDGET_DRIVER_FAIL_FULL === '1') process.exit(9);
