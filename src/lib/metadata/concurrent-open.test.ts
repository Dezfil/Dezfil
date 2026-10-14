import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MIGRATIONS, open } from "./db";
import { allocateSqlNames, type SqlNameIdentity } from "./sql-names";

let directory: string, workerFile: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "concurrent-open-"));
  workerFile = path.join(directory, "opener.mjs");
  writeFileSync(workerFile, `
    import { registerHooks, createRequire } from 'node:module';
    import { existsSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    const [root, file, pause] = process.argv.slice(2);
    const pauseVersion = pause === 'true';
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    registerHooks({ resolve(specifier, context, next) {
      const target = specifier.startsWith('@/') ? pathToFileURL(root + '/src/' + specifier.slice(2)).href : specifier;
      if ((target.startsWith('.') || target.startsWith('file:')) && context.parentURL) {
        const candidate = new URL(target + '.ts', context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return { ...next(candidate.href, context), format: 'module-typescript' };
      }
      const result = next(target, context);
      return result.url.endsWith('.ts') ? { ...result, format: 'module-typescript' } : result;
    }});
    const require = createRequire(root + '/package.json');
    const Database = require('better-sqlite3');
    const pragma = Database.prototype.pragma;
    Database.prototype.pragma = function(sql, options) {
      const value = pragma.call(this, sql, options);
      // Hold an unlocked version read until both openers have read the same
      // version. A properly locked read never enters this barrier.
      if (pauseVersion && sql === 'user_version' && !this.inTransaction) {
        process.stdout.write('version\\n');
        const deadline = performance.now() + 10000;
        while (!existsSync(file + '.release')) {
          if (performance.now() > deadline) throw new Error('Version barrier timed out');
          Atomics.wait(sleeper, 0, 0, 5);
        }
      }
      return value;
    };
    const { open } = await import(pathToFileURL(root + '/src/lib/metadata/db.ts'));
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
    try {
      const db = open(file);
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const foreignKeys = db.pragma('foreign_keys', { simple: true });
      const integrity = db.pragma('integrity_check', { simple: true });
      db.close();
      process.stdout.write(JSON.stringify({ ok: true, version, foreignKeys, integrity }) + '\\n');
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, message: error.message, code: error.code }) + '\\n'); }
    finally { process.stdin.destroy(); }
    });
  `);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function race(file: string, pauseVersion: boolean) {
  const children = [0, 1].map(() => spawn(process.execPath, [workerFile, process.cwd(), file, String(pauseVersion)], {
    stdio: ["pipe", "pipe", "pipe"], timeout: 15000,
  }));
  try {
    let ready = 0, versions = 0;
    return await Promise.all(children.map(child => new Promise((resolve, reject) => {
      let output = "", errors = "", result: unknown;
      child.stdout.on("data", chunk => {
        output += chunk;
        let end: number;
        while ((end = output.indexOf("\n")) >= 0) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          if (line === "ready") {
            if (++ready === 2) children.forEach(process => process.stdin.end("go"));
          } else if (line === "version") {
            if (++versions === 2) writeFileSync(file + ".release", "go");
          } else result = JSON.parse(line);
        }
      });
      child.stderr.on("data", chunk => { errors += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve(code === 0 && result ? result : { ok: false, code, signal, errors }));
    })));
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill(); }); }
}

it("opens the same fresh file concurrently, including its WAL switch", async () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const results = await race(path.join(directory, `fresh-${attempt}.sqlite`), false);
    expect(results).toEqual(Array(2).fill({ ok: true, version: MIGRATIONS.length, foreignKeys: 1, integrity: "ok" }));
  }
});

it.each([0, 46])("serializes the version read and migration from version %s", async version => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = path.join(directory, `version-${version}-${attempt}.sqlite`);
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.function("allocate_sql_names", (input: unknown) => JSON.stringify(allocateSqlNames(JSON.parse(String(input)) as SqlNameIdentity[])));
    for (const sql of MIGRATIONS.slice(0, version)) db.exec(sql);
    db.pragma(`user_version = ${version}`); db.close();
    expect(await race(file, true)).toEqual(Array(2).fill({ ok: true, version: MIGRATIONS.length, foreignKeys: 1, integrity: "ok" }));
    const current = open(file);
    expect(current.pragma("foreign_key_check")).toEqual([]);
    current.close();
  }
});

it("retries a transient WAL lock and restores the connection's busy wait", () => {
  const native = Database.prototype.pragma;
  let blocked = false;
  const spy = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, sql, options) {
    if (sql === "journal_mode = WAL" && !blocked) {
      blocked = true;
      throw new Database.SqliteError("database is locked", "SQLITE_BUSY");
    }
    return native.call(this, sql, options);
  });
  try {
    const db = open(path.join(directory, "wal.sqlite"));
    try {
      expect(blocked).toBe(true);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally { db.close(); }
  } finally { spy.mockRestore(); }
});
