import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { statSync } from "node:fs";
import { compactMetadataStore } from "@/lib/metadata/account-compaction.mjs";
import { compactionFixture } from "../../../test-support/account-compaction-fixture";
import { proveErasure } from "../../../test-support/account-erasure-proof";
import { erasureInventory } from "./account-erasure-inventory";
let f: ReturnType<typeof compactionFixture>;
beforeEach(() => { f = compactionFixture(); });
afterEach(() => { vi.restoreAllMocks(); f.dispose(); });
const requireFormer = () => expect(f.formerImmediately).toEqual(f.target.slice(0, 3));
it("finds former values immediately after change and removes every planted value from the same open live store with controls intact", async () => {
  requireFormer(); expect(f.scan()).toEqual({ target: f.target, control: f.control });
  const inventory = { ...erasureInventory, stores: { "file:metadata": erasureInventory.stores["file:metadata"] } };
  const rows = () => Object.fromEntries((f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, f.db.prepare(`SELECT * FROM ${name}`).all().map(r => JSON.stringify(r)).sort()]));
  let survivors: ReturnType<typeof rows>;
  await proveErasure(inventory, { "file:metadata": { populate() {}, dispose() {}, observe: f.scan } }, () => { f.erase(); survivors = rows(); compactMetadataStore(f.db); });
  expect(rows()).toEqual(survivors!);
  expect(f.db.open).toBe(true); expect(statSync(`${f.file}-wal`).size).toBe(0);
  expect(f.db.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
});
it("detects seeded row-only erasure, including after a truncating checkpoint without a rewrite", () => {
  requireFormer(); f.erase(); expect(f.scan().target.length).toBeGreaterThan(0);
  f.db.pragma("wal_checkpoint(TRUNCATE)"); expect(f.scan().target.length).toBeGreaterThan(0);
  compactMetadataStore(f.db); expect(f.scan()).toEqual({ target: [], control: f.control });
});
it("refuses a held outside reader as unfinished with bounded waits, then retries on the same open store", () => {
  const reader = new Database(f.file, { readonly: true });
  try {
    reader.exec("BEGIN"); reader.prepare("SELECT * FROM accounts").all(); f.erase();
    const started = performance.now();
    expect(() => compactMetadataStore(f.db)).toThrow();
    expect(performance.now() - started).toBeLessThan(1500);
    expect(statSync(`${f.file}-wal`).size).toBeGreaterThan(0);
    expect(f.scan().target.length).toBeGreaterThan(0);
    reader.exec("ROLLBACK"); compactMetadataStore(f.db);
    expect(f.scan()).toEqual({ target: [], control: f.control });
  } finally { reader.close(); }
});
it("requires its own maintenance interval and drains unfinished statements", () => {
  f.erase();
  expect(() => f.db.transaction(() => compactMetadataStore(f.db))()).toThrow();
  const iterator = f.db.prepare("SELECT * FROM accounts").iterate(); iterator.next();
  expect(() => compactMetadataStore(f.db)).toThrow(); iterator.return?.();
  compactMetadataStore(f.db); expect(f.scan().target).toEqual([]);
});
it("inspects checkpoint results and actual WAL length, restoring the original lock wait on every exit", () => {
  f.erase(); f.db.pragma("busy_timeout = 987");
  const original = f.db.pragma.bind(f.db);
  vi.spyOn(f.db, "pragma").mockImplementation((sql: string, options?: Database.PragmaOptions) =>
    sql === "wal_checkpoint(TRUNCATE)" ? [{ busy: 0, log: 0, checkpointed: 0 }] : original(sql, options));
  expect(() => compactMetadataStore(f.db)).toThrow("WAL");
  expect(original("busy_timeout", { simple: true })).toBe(987);
  vi.restoreAllMocks(); compactMetadataStore(f.db); expect(f.scan().target).toEqual([]);
});
it("does not accept a non-truncating checkpoint merely because it reported no busy reader", () => {
  f.erase(); const original = f.db.pragma.bind(f.db);
  vi.spyOn(f.db, "pragma").mockImplementation((sql: string, options?: Database.PragmaOptions) =>
    sql === "wal_checkpoint(TRUNCATE)" ? [{ busy: 0, log: 3, checkpointed: 3 }] : original(sql, options));
  expect(() => compactMetadataStore(f.db)).toThrow("checkpoint");
});
