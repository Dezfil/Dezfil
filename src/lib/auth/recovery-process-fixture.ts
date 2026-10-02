import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RecoveryProcessResult {
  ok: boolean;
  code?: string;
  message?: string;
  elapsed: number;
  url?: string;
  expiresAt?: number;
  secret?: string;
  account?: { id: string; isAdmin: boolean };
}

/** Independent Node processes, synchronized with pipes rather than sockets.
 * The optional hash barrier pauses after real password work, before commit. */
export function recoveryProcess(directory: string, pauseAfterHash = false) {
  const root = process.cwd();
  const fixture = mkdtempSync(path.join(directory, "process-"));
  const loader = path.join(fixture, "loader.mjs"), worker = path.join(fixture, "worker.mjs");
  const shim = path.join(fixture, "passwords.mjs");
  writeFileSync(shim, `import { hashPassword as realHash } from ${JSON.stringify(`${root}/src/lib/auth/passwords.ts`)};
    export async function hashPassword(password) {
      const hash = await realHash(password);
      process.stdout.write('hashed\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      return hash;
    }`);
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    import { existsSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    registerHooks({ resolve(specifier, context, next) {
      if (${pauseAfterHash} && specifier === './passwords' && context.parentURL?.endsWith('/auth/links.ts'))
        return next(pathToFileURL(${JSON.stringify(shim)}).href, context);
      if (specifier.startsWith('@/')) return next(pathToFileURL(${JSON.stringify(root)} + '/src/' + specifier.slice(2) + '.ts').href, context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const candidate = new URL(specifier + '.ts', context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
      return next(specifier, context);
    }});`);
  writeFileSync(worker, `import Database from ${JSON.stringify(`${root}/node_modules/better-sqlite3/lib/index.js`)};
    import { recoverAdmin } from ${JSON.stringify(`${root}/src/lib/auth/recovery.mjs`)};
    import { redeemSignInLink } from ${JSON.stringify(`${root}/src/lib/auth/links.ts`)};
    const db = new Database(${JSON.stringify(path.join(directory, "metadata.sqlite"))}, { fileMustExist: true });
    process.stdout.write('ready\\n');
    process.stdin.once('data', async input => {
      const action = JSON.parse(input.toString()), started = performance.now();
      try {
        let result = {};
        if (action.kind === 'issue') result = recoverAdmin({ dataDir: ${JSON.stringify(directory)}, origin: 'https://maps.example.test', email: action.email }, action.now);
        if (action.kind === 'redeem') result = await redeemSignInLink(action.secret, action.password, db, action.now);
        if (action.kind === 'lock') {
          db.exec('BEGIN IMMEDIATE');
          if (action.deactivate) db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
          process.stdout.write('locked\\n');
          await new Promise(resolve => setTimeout(resolve, action.duration));
          db.exec('COMMIT');
        }
        process.stdout.write(JSON.stringify({ ok: true, ...result, elapsed: performance.now() - started }) + '\\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message, elapsed: performance.now() - started }) + '\\n');
      } finally { db.close(); process.stdin.destroy(); }
    });`);
  const child = spawn(process.execPath, ["--experimental-transform-types", "--import", loader, worker],
    { env: { ...process.env, DEZFIL_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
  const signals = new Map<string, () => void>();
  const ready = new Promise<void>(resolve => signals.set("ready", resolve));
  const locked = new Promise<void>(resolve => signals.set("locked", resolve));
  const hashed = new Promise<void>(resolve => signals.set("hashed", resolve));
  let pending = "", resultValue: RecoveryProcessResult | undefined;
  const result = new Promise<RecoveryProcessResult>((resolve, reject) => {
    child.stdout.on("data", chunk => {
      pending += chunk;
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"), line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (signals.has(line)) signals.get(line)!();
        else { try { resultValue = JSON.parse(line); } catch { reject(new Error("Recovery worker returned invalid output.")); } }
      }
    });
    // Drain warnings without attaching possible credential output to failures.
    child.stderr.resume();
    child.on("error", () => reject(new Error("Recovery worker could not start.")));
    child.on("exit", code => {
      if (code === 0 && resultValue) resolve(resultValue);
      else reject(new Error(`Recovery worker exited ${code} without a result.`));
    });
  });
  void result.catch(() => {});
  const until = (signal: Promise<void>) => Promise.race([signal, result.then(() => { throw new Error("Recovery worker exited before its barrier."); })]);
  return { ready: until(ready), locked: () => until(locked), hashed: () => until(hashed), result,
    start: (action: object) => child.stdin.write(JSON.stringify(action)),
    resume: () => child.stdin.write("continue"),
    stop: () => { if (child.exitCode === null) child.kill(); },
  };
}
