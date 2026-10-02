#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { recoverAdmin } from "../src/lib/auth/recovery.mjs";
import { RecoveryError, recoveryFailure } from "../src/lib/auth/recovery-store.mjs";

const usage = "Usage: npm run admin:recover -- --data-dir DIRECTORY --origin HTTP_OR_HTTPS_ORIGIN [--email ADMIN_EMAIL]";
function argumentsForRecovery(args) {
  const options = {};
  const names = { "--data-dir": "dataDir", "--origin": "origin", "--email": "email" };
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]], value = args[i + 1];
    if (!name || Object.hasOwn(options, name) || !value || value.startsWith("--")) throw new RecoveryError(usage);
    options[name] = value;
  }
  if (!options.dataDir || !options.origin) throw new RecoveryError(usage);
  return options;
}

/** Output is injected for tests; the executable uses only its invoking terminal.
 * @param {string[]} args
 * @param {{ isTTY: boolean; write: (value: string) => void; error: (value: string) => void }} io
 */
export function runAdminRecover(args, io = {
  isTTY: process.stdout.isTTY === true,
  write: value => process.stdout.write(value),
  error: value => process.stderr.write(value),
}) {
  try {
    if (args.length === 1 && args[0] === "--help") { io.write(`${usage}\n`); return 0; }
    const options = argumentsForRecovery(args);
    if (!io.isTTY) throw new RecoveryError("Run admin recovery in a terminal. For container exec or one-off use, allocate a TTY with -t. No credentials changed.");
    const result = recoverAdmin(options);
    // One write after the transaction commits. JSON quoting prevents account text from controlling the terminal.
    io.write(`Account: ${JSON.stringify(result.account.email)}\nExpires: ${new Date(result.expiresAt).toISOString()}\n${result.url}\n`);
    return 0;
  } catch (error) {
    io.error(`${recoveryFailure(error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAdminRecover(process.argv.slice(2));
}
