import { testAccountScope } from "@/lib/test-support/accounts";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createLegacyStore, legacy, legacyFiles, legacyRows, readLegacyPassword } from "../../../scripts/legacy-store-fixture.mjs";
import { open } from "@/lib/metadata/db";
import { connectionPassword } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";
import { createFirstAccount } from "./accounts";

it("upgrades a copy of real old-schema artifacts without touching the seed or losing encrypted credentials", async () => {
  const directory = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "upgrade-"));
  const source = path.join(directory, "source"), copy = path.join(directory, "copy");
  await mkdir(source);
  try {
    await createLegacyStore(source);
    const original = await legacyFiles(source);
    const old = new Database(path.join(source, "metadata.sqlite"), { readonly: true });
    expect(old.pragma("user_version", { simple: true })).toBe(legacy.version);
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'accounts'").get()).toBeUndefined();
    const rows = legacyRows(old); old.close();
    await cp(source, copy, { recursive: true });
    const db = open(path.join(copy, "metadata.sqlite"));
    try {
      expect(legacyRows(db)).toEqual(rows);
      const owned = ["projects", "maps", "data_tables", "recipes", "pg_connections"];
      for (const table of owned) expect(db.prepare(`SELECT DISTINCT owner_id FROM ${table}`).all()).toEqual([{ owner_id: null }]);
      const first = await createFirstAccount({ name: legacy.name, email: "upgrade@example.test", password: "field notebooks at dawn" }, db);
      expect(first.account.isOriginal).toBe(true);
      for (const table of owned) expect(db.prepare(`SELECT DISTINCT owner_id FROM ${table}`).all()).toEqual([{ owner_id: first.account.id }]);
      expect(legacyRows(db)).toEqual(rows);
      expect(await readLegacyPassword(copy, db)).toBe(legacy.password);
      vi.stubEnv("DEZFIL_DATA_DIR", copy);
      vi.stubEnv("DEZFIL_SECRET_KEY", undefined);
      resetSecretKeyCache();
      expect(connectionPassword(testAccountScope(db, first.account.id), legacy.connection, db)).toBe(legacy.password);
      expect(await legacyFiles(source)).toEqual(original);
      expect((await legacyFiles(copy))["tables/legacy.parquet"]).toBe(original["tables/legacy.parquet"]);
    } finally { db.close(); }
  } finally {
    resetSecretKeyCache();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
