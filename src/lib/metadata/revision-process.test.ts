import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { open } from "./db";
import { getAccount } from "./accounts";
import { issueSession } from "@/lib/auth/credentials";
import { testAccountScope } from "@/lib/test-support/accounts";
import { recordDocumentCreation, readDocumentRevision } from "./revisions";

interface Outcome { ok: boolean; code?: string; message?: string }

it.each([false, true])("allows only one competing process to change a document (same account: %s)", async sameAccount => {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "revision-process-"));
  const file = path.join(directory, "metadata.sqlite");
  const db = open(file);
  const root = process.cwd();
  const loader = path.join(directory, "loader.mjs");
  const worker = path.join(directory, "worker.mjs");
  const document = { kind: "map" as const, id: "map" };
  const ada = testAccountScope(db, "ada");
  testAccountScope(db, "bea");
  db.exec(`INSERT INTO projects (id, name, owner_id, created_at, updated_at) VALUES ('project', 'P', 'ada', 't', 't');
    INSERT INTO project_people VALUES ('project', 'bea', 'editor', 't');
    INSERT INTO maps (id, name, owner_id, project_id, created_at, updated_at) VALUES ('map', 'Before', 'ada', 'project', 't', 't');`);
  db.transaction(() => recordDocumentCreation(ada, document, db))();
  const expectedRevision = readDocumentRevision(document, db)!.editRevision;
  const actions = ["ada", sameAccount ? "ada" : "bea"].map((id, i) => ({
    secret: issueSession(getAccount(id, db)!, db, Date.now()).secret,
    name: `Writer ${i}`, expectedRevision,
  }));
  writeFileSync(loader, `import { registerHooks } from 'node:module';
    import { existsSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    registerHooks({ resolve(specifier, context, next) {
      // Scratch workers may live outside the checkout. Resolve packages
      // from the application, independent of the data directory's parents.
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':') && !specifier.startsWith('@/')) {
        context = { ...context, parentURL: pathToFileURL(${JSON.stringify(root)} + '/package.json').href };
      }
      if (specifier === 'next/server') return next('next/server.js', context);
      if (specifier.startsWith('@/')) return next(pathToFileURL(${JSON.stringify(root)} + '/src/' + specifier.slice(2) + '.ts').href, context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const candidate = new URL(specifier + '.ts', context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
      return next(specifier, context);
    }});`);
  writeFileSync(worker, `import Database from 'better-sqlite3';
    import { authenticateSession } from '@/lib/auth/credentials';
    import { accountScope } from '@/lib/auth/scope';
    import { commitDocumentChanges } from '@/lib/metadata/revisions';
    // The parent alone initializes this store. Workers only open it.
    const db = new Database(${JSON.stringify(file)});
    db.pragma('foreign_keys = ON');
    process.stdout.write('ready\\n');
    process.stdin.once('data', data => {
      const action = JSON.parse(data.toString());
      try {
        const scope = accountScope(authenticateSession(action.secret, db), db);
        commitDocumentChanges(scope, {
          expected: [{kind: 'map', id: 'map', expectedRevision: action.expectedRevision}],
          authorize: () => {},
          apply: () => {
            db.prepare('UPDATE maps SET name = ? WHERE id = ?').run(action.name, 'map');
            return {value: null, changes: [{kind: 'map', id: 'map'}]};
          }
        }, db);
        process.stdout.write(JSON.stringify({ok: true}) + '\\n');
      } catch (error) { process.stdout.write(JSON.stringify({ok: false, code: error.code, message: error.message}) + '\\n'); }
      finally { db.close(); process.stdin.destroy(); }
    });`);
  const children = actions.map(() => spawn(process.execPath,
    ["--experimental-transform-types", "--import", loader, worker], { stdio: ["pipe", "pipe", "pipe"] }));
  try {
    const pending = children.map(child => {
      let output = "", errors = "";
      let readyResolve!: () => void, readyReject!: (e: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const result = new Promise<Outcome>((resolve, reject) => {
        child.stdout.on("data", chunk => { output += chunk; if (output.startsWith("ready\n")) readyResolve(); });
        child.stderr.on("data", chunk => { errors += chunk; });
        child.on("error", error => { readyReject(error); reject(error); });
        child.on("exit", code => {
          if (code !== 0) { const error = new Error(`Revision worker exited ${code}: ${errors}`); readyReject(error); reject(error); }
          else resolve(JSON.parse(output.trim().split("\n").at(-1)!));
        });
      });
      void result.catch(() => {});
      return { ready, result };
    });
    await Promise.all(pending.map(p => p.ready));
    children.forEach((child, i) => child.stdin.write(JSON.stringify(actions[i])));
    const results = await Promise.all(pending.map(p => p.result));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toEqual({ ok: false, code: "stale_revision",
      message: "This item has changed. Reload it before trying again." });
    const winner = results.findIndex(r => r.ok);
    expect(db.prepare("SELECT name FROM maps WHERE id = 'map'").get()).toEqual({ name: actions[winner].name });
    const committed = readDocumentRevision(document, db)!;
    expect(committed.editRevision).not.toBe(expectedRevision);
    expect(committed.lastChangedBy).toBe(sameAccount || winner === 0 ? "ada" : "bea");
    db.close();
    const reopened = open(file);
    try { expect(readDocumentRevision(document, reopened)).toEqual(committed); }
    finally { reopened.close(); }
  } finally {
    children.forEach(child => { if (child.exitCode === null) child.kill(); });
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
