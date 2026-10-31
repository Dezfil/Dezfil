import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { listAccounts } from "@/lib/metadata/accounts";
import { createFirstAccount } from "./accounts";
import { changeAccountAccess, inviteAccount } from "./admin";
import { authenticateSession } from "./credentials";
import { redeemSignInLink } from "./links";

const password = "river otter telescope";
const now = Date.parse("2026-01-01T00:00:00Z");
let directory: string, file: string, db: Database;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "dezfil-auth-process-"));
  file = path.join(directory, "metadata.sqlite"); db = open(file);
});
afterEach(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

interface Result { ok: boolean; code?: string; }

/** Use separate processes and simultaneous admission, not merely queued sync calls.
 * Node's type transform runs the same services without starting an app server. */
async function race(actions: object[]): Promise<Result[]> {
  const root = process.cwd();
  const loader = path.join(directory, "loader.mjs");
  const worker = path.join(directory, "worker.mjs");
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    import { existsSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "next/server") return next("next/server.js", context);
      if (specifier.startsWith('@/')) return next(pathToFileURL(${JSON.stringify(root)} + '/src/' + specifier.slice(2) + '.ts').href, context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const candidate = new URL(specifier + '.ts', context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
      return next(specifier, context);
    }});`);
  writeFileSync(worker, String.raw`import { pathToFileURL } from 'node:url';
    const root = ${JSON.stringify(root)};
    const { open } = await import(pathToFileURL(root + '/src/lib/metadata/db.ts'));
    const { createFirstAccount } = await import(pathToFileURL(root + '/src/lib/auth/accounts.ts'));
    const { changeAccountAccess } = await import(pathToFileURL(root + '/src/lib/auth/admin.ts'));
    const { redeemSignInLink } = await import(pathToFileURL(root + '/src/lib/auth/links.ts'));
    const db = open(${JSON.stringify(file)});
    process.stdout.write('ready\n');
    process.stdin.once('data', async data => {
      const action = JSON.parse(data.toString());
      try {
        if (action.kind === 'setup') await createFirstAccount(action.input, db, action.now);
        if (action.kind === 'link') await redeemSignInLink(action.secret, action.password, db, action.now);
        if (action.kind === 'access') changeAccountAccess(action.context, action.target, action.patch, db, action.now);
        process.stdout.write(JSON.stringify({ ok: true }) + '\n');
      } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code }) + '\n'); }
      finally { db.close(); process.stdin.destroy(); }
    });`);
  const children = actions.map(() => spawn(process.execPath,
    ["--experimental-transform-types", "--import", loader, worker], { stdio: ["pipe", "pipe", "pipe"] }));
  try {
    const results = children.map(child => {
      let output = "", errors = "";
      let readyResolve: () => void, readyReject: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const result = new Promise<Result>((resolve, reject) => {
        child.stdout.on("data", chunk => { output += chunk; if (output.startsWith("ready\n")) readyResolve(); });
        child.stderr.on("data", chunk => { errors += chunk; });
        child.on("error", error => { readyReject(error); reject(error); });
        child.on("exit", code => {
          if (code !== 0) { const error = new Error(`Credential worker exited ${code}: ${errors}`); readyReject(error); reject(error); }
          else resolve(JSON.parse(output.trim().split("\n").at(-1)!));
        });
      });
      // Register both rejection handlers before either worker can fail.
      void result.catch(() => {});
      return { ready, result };
    });
    await Promise.all(results.map(result => result.ready));
    children.forEach((child, index) => child.stdin.end(JSON.stringify(actions[index])));
    return await Promise.all(results.map(result => result.result));
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill(); }); }
}

it("serializes first-account creation across processes", async () => {
  const results = await race([0, 1].map(index => ({ kind: "setup", now,
    input: { name: `Person ${index}`, email: `person${index}@example.test`, password } })));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.find(result => !result.ok)?.code).toBe("setup_complete");
  expect(listAccounts(db)).toHaveLength(1);
  expect(listAccounts(db)[0]).toMatchObject({ isAdmin: true, isOriginal: true });
  expect(db.prepare("SELECT count(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
});

it("consumes a sign-in link once across processes", async () => {
  const first = await createFirstAccount({ name: "Ada", email: "ada@example.test", password }, db, now);
  const admin = authenticateSession(first.secret, db, now)!;
  const invited = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, now);
  const action = { kind: "link", secret: invited.secret, password, now };
  const results = await race([action, action]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.find(result => !result.ok)?.code).toBe("invalid_link");
  expect(db.prepare("SELECT count(*) AS count FROM auth_sessions WHERE account_id = ?").get(invited.account.id)).toEqual({ count: 1 });
});

it.each(["role", "deactivate"])("retains an active admin when separate processes compete to %s", async operation => {
  const first = await createFirstAccount({ name: "Ada", email: "ada@example.test", password }, db, now);
  const admin = authenticateSession(first.secret, db, now)!;
  const invited = inviteAccount(admin, { name: "Lin", email: "lin@example.test" }, db, now);
  const member = await redeemSignInLink(invited.secret!, password, db, now);
  changeAccountAccess(admin, member.account.id, { isAdmin: true }, db, now);
  const other = authenticateSession(member.secret, db, now)!;
  const patch = operation === "role" ? { isAdmin: false } : { status: "deactivated" };
  const results = await race([
    { kind: "access", context: admin, target: other.account.id, patch, now },
    { kind: "access", context: other, target: admin.account.id, patch, now },
  ]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.find(result => !result.ok)?.code).toBe(operation === "role" ? "forbidden" : "authentication_required");
  expect(listAccounts(db).filter(account => account.isAdmin && account.status === "active")).toHaveLength(1);
});
