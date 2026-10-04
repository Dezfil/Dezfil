import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { open } from "@/lib/metadata/db";
import { discoverFiles, discoverSourceStores, discoverStores, productSources, type Discovery } from "../../../test-support/account-erasure-discovery";
import { fileProblems, inventoryProblems, type ErasureInventory } from "../../../test-support/account-erasure-proof";
import { populateErasureFiles } from "../../../test-support/account-erasure-file-fixture";
import { erasureInventory } from "./account-erasure-inventory";
let discovered: Discovery;
const sources = productSources(), db = open(":memory:");
beforeAll(() => { discovered = discoverStores(db, sources);
  if (process.env.ERASURE_DISCOVERY_DUMP) writeFileSync(path.join(process.env.DEZFIL_DATA_DIR!, "discovery.json"), JSON.stringify(discovered, null, 2));
});
afterAll(() => db.close());
const issues = (changed: Discovery, inventory: ErasureInventory = erasureInventory) => inventoryProblems(changed, inventory);
function schemaMutation(sql: string): Discovery {
  db.exec("BEGIN");
  try {
    db.exec(sql); const found = discoverStores(db, new Map());
    return { ...found, sources: discovered.sources };
  } finally { db.exec("ROLLBACK"); }
}
it("classifies independent live schema and source discovery in both directions", () => {
  expect(issues(discovered)).toEqual([]);
  for (const classification of ["server", "local", "browser", "immutable"]) expect(discovered.sources.some(s => s.classification === classification)).toBe(true);
});
it("rejects an added durable table independently", () => {
  expect(issues(schemaMutation("CREATE TABLE forgotten_store (id TEXT PRIMARY KEY, secret TEXT)"))).toEqual(["Unclassified table: forgotten_store"]);
});
it("rejects an unclassified account foreign key on an already inventoried table independently", () => {
  expect(issues(schemaMutation("ALTER TABLE maps ADD COLUMN extra_actor TEXT REFERENCES accounts(id)"))).toEqual(["Unclassified account foreign key: maps.extra_actor"]);
});
it("rejects an extra retained-identity column even if its declaration is added", () => {
  const changed = schemaMutation("ALTER TABLE accounts ADD COLUMN retained_email TEXT");
  expect(issues(changed)).toEqual(["Unclassified identity column: retained_email"]);
  const declaration = structuredClone(erasureInventory) as ErasureInventory;
  declaration.identityColumns.retained_email = "retain";
  expect(issues(changed, declaration)).toEqual(["Retained identity must be exactly id, sql_name and status"]);
});
it("rejects a fictitious inventory entry independently", () => {
  const declaration = structuredClone(erasureInventory) as ErasureInventory;
  declaration.sources["memory:src/lib/removed-store.ts#entries"] = { stores: ["table:accounts"] };
  expect(issues(discovered, declaration)).toEqual(["Stale source: memory:src/lib/removed-store.ts#entries"]);
});
it.each([
  ["aliased accessor writer", `import { dataDir as volume } from '@/lib/config'; import { writeFile as persist } from 'node:fs/promises'; import path from 'node:path';
    const rootAlias = volume; function folder() { const root = rootAlias(); const joined = path.join(root, 'forgotten'); return joined; }
    function wrapper(file: string) { return persist(file, 'private'); }
    export async function added() { const target = path.join(folder(), 'value'); await wrapper(target); }`, "writer:", "added:wrapper"],
  ["factory collection", `function factory() { const entries = new Map<string, string>(); return { get: (key: string) => entries.get(key) }; } export const retained = factory();`, "memory:", "factory.entries"],
  ["attached callable", `function factory() { const entries = new Map<string, string>(); const read = (key: string) => entries.get(key); return Object.assign(read, { size: () => entries.size }); } export const retained = factory();`, "memory:", "factory.entries"],
  ["weak collection", `function factory() { const entries = new WeakMap<object, string>(); return (key: object) => entries.get(key); } export const retained = factory();`, "memory:", "factory.entries"],
  ["singleton class", `class Holder { entries = new WeakSet<object>(); } export const retained = new Holder();`, "memory:", "Holder.entries"],
  ["process holder", `export function install() { const entries = new Map<string, string>(); globalThis['retained'] = entries; }`, "memory:", "install.entries"],
] as const)("rejects a seeded %s through structural discovery", (_label, source, kind, suffix) => {
  const file = "src/lib/erasure-discovery-seed.ts", changed = new Map(sources).set(file, source);
  const found = discoverSourceStores(changed);
  const id = `${kind}${file}#${suffix}`;
  expect(found).toContainEqual(expect.objectContaining({ id, classification: "server" }));
  expect(issues({ ...discovered, sources: found })).toContain(`Unclassified source: ${id}`);
});
it("checks changed locations even when their source identifier stays the same", () => {
  const altered = structuredClone(discovered);
  const entry = altered.sources.find(s => s.kind === "writer")!; entry.roots = ["unclassified-private-files"];
  expect(issues(altered)).toEqual([`Changed location: ${entry.id}`]);
});
it("independently lists populated files, including open SQLite sidecars, and refuses new locations", () => {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "inventory-files-"));
  const fixture = populateErasureFiles(directory);
  try {
    const files = discoverFiles(directory);
    expect(files).toEqual(expect.arrayContaining(["metadata.sqlite", "metadata.sqlite-wal", "metadata.sqlite-shm", ...fixture.paths]));
    expect(fileProblems(files, erasureInventory)).toEqual([]);
    mkdirSync(path.join(directory, "forgotten")); writeFileSync(path.join(directory, "forgotten/private.bin"), "sentinel");
    expect(fileProblems(discoverFiles(directory), erasureInventory)).toEqual(["Unclassified file: forgotten/private.bin"]);
    const missing = files.filter(f => !f.startsWith("cache/isochrone/"));
    expect(fileProblems(missing, erasureInventory)).toEqual(["Unpopulated file store: file:isochrone"]);
  } finally { fixture.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
