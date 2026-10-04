import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withUpgradeStore } from "../../../scripts/account-upgrade-store.mjs";

let directory: string, remote: string, scratch: string, live: Database.Database;
const calls: string[][] = [];
beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "upgrade-snapshot-"));
  remote = path.join(directory, "container-store"); scratch = path.join(directory, "snapshots");
  mkdirSync(remote); mkdirSync(scratch); calls.length = 0;
  live = new Database(path.join(remote, "metadata.sqlite"));
  live.pragma("journal_mode = WAL"); live.pragma("wal_autocheckpoint = 0");
  live.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('committed WAL value')");
});
afterEach(() => { live.close(); rmSync(directory, { recursive: true, force: true }); });

// Execute the actual backup command in a separate local process. The adapter
// only substitutes container paths; no Docker process or server is launched.
function docker(...args: string[]) {
  calls.push(args);
  if (args[0] === "cp") {
    copyFileSync(path.join(remote, path.basename(args[1])), args[2]); return "";
  }
  expect(args.slice(0, 4)).toEqual(["exec", "proof-container", "node", "-e"]);
  const mapped = args.slice(5).map(file => path.join(remote, path.basename(file)));
  return execFileSync(process.execPath, ["-e", args[4], ...mapped], { encoding: "utf8" });
}
function options() {
  return { directory: path.join(directory, "inaccessible-host-mount"), scratch, container: "proof-container", docker };
}

it("inspects fresh closed container snapshots including committed WAL frames", async () => {
  let inspected: Database.Database | undefined;
  const inspect = (db: Database.Database) => {
    inspected = db;
    expect(db.name.startsWith(scratch)).toBe(true);
    expect(db.readonly).toBe(true);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    return db.prepare("SELECT value FROM evidence ORDER BY rowid").all();
  };
  expect(await withUpgradeStore(options(), inspect)).toEqual([{ value: "committed WAL value" }]);
  expect(inspected!.open).toBe(false);
  live.exec("INSERT INTO evidence VALUES ('later checkpoint')");
  expect(await withUpgradeStore(options(), inspect)).toHaveLength(2);
  expect(calls.filter(call => call[0] === "cp")).toHaveLength(2);
  expect(readdirSync(scratch)).toEqual([]);
  expect(readdirSync(remote).filter(file => file.startsWith("inspection-"))).toEqual([]);
  expect(live.open).toBe(true);
});
it("closes and removes snapshots even when a preservation assertion fails", async () => {
  let inspected: Database.Database | undefined;
  await expect(withUpgradeStore(options(), (db: Database.Database) => {
    inspected = db; throw new Error("ownership changed");
  })).rejects.toThrow("ownership changed");
  expect(inspected!.open).toBe(false);
  expect(readdirSync(scratch)).toEqual([]);
  expect(readdirSync(remote).filter(file => file.startsWith("inspection-"))).toEqual([]);
});
it("fails if the container snapshot cannot be copied, without opening the host mount", async () => {
  const failing = (...args: string[]) => {
    if (args[0] === "cp") throw new Error("copy failed");
    return docker(...args);
  };
  await expect(withUpgradeStore({ ...options(), docker: failing }, () => {})).rejects.toThrow("copy failed");
  expect(existsSync(options().directory)).toBe(false);
  expect(readdirSync(scratch)).toEqual([]);
  expect(readdirSync(remote).filter(file => file.startsWith("inspection-"))).toEqual([]);
});
it("keeps checkout inspection read-only on its local store and closes it", async () => {
  let inspected: Database.Database | undefined;
  await withUpgradeStore({ directory: remote, scratch, container: undefined, docker }, (db: Database.Database) => {
    inspected = db; expect(db.readonly).toBe(true);
    expect(db.prepare("SELECT value FROM evidence").get()).toEqual({ value: "committed WAL value" });
  });
  expect(inspected!.open).toBe(false); expect(calls).toEqual([]);
});
