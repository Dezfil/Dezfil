import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { erasureInventory } from "./account-erasure-inventory";
import { proveErasure, type ErasureInventory, type ErasureProbe } from "../../../test-support/account-erasure-proof";

const obligations = Object.entries(erasureInventory.stores).filter(([, s]) => s.action !== "retain").map(([id]) => id);
it.each(obligations)("requires a populated fixture for %s before any erase callback", async id => {
  // Deliberately unusable callbacks: the completeness check must run before
  // populating anything or allowing a destructive coordinator to start.
  const unexpected = () => { throw new Error("probe was called before completeness"); };
  const probes = Object.fromEntries(obligations.filter(key => key !== id).map(key => [key,
    { populate: unexpected, observe: unexpected, dispose: unexpected }]));
  const erase = vi.fn();
  await expect(proveErasure(erasureInventory, probes, erase)).rejects.toThrow(`Missing populated probe: ${id}`);
  expect(erase).not.toHaveBeenCalled();
});

// These exercise the proof oracle on actual row/file/collection observations.
// They are not evidence that the not-yet-exposed account cleanup erased a store.
const ledger: ErasureInventory = {
  stores: {
    rows: { action: "erase", rule: "Target preferences", fixture: "rows" },
    files: { action: "erase", rule: "Target bytes", fixture: "files" },
    memory: { action: "erase", rule: "Target retained values", fixture: "memory" },
    cache: { action: "purge", rule: "All provider answers", fixture: "cache" },
  }, tables: {}, sources: {}, files: {}, accountReferences: {}, identityColumns: {},
};
function populatedProbes(empty = false) {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "erasure-oracle-"));
  const db = open(":memory:"), memory = new Map<string, string>(), cache = new Map<string, string>();
  const probes: Record<string, ErasureProbe> = {
    rows: {
      populate() {
        for (const id of ["target", "control"]) {
          insertAccount({ id, name: id, email: `${id}@example.test`, status: "active", passwordHash: null, isAdmin: false, now: "time" }, db);
          if (!empty || id !== "target") db.prepare("INSERT INTO account_preferences VALUES (?, ?, 'time')").run(id, `${id}-prefs`);
        }
      },
      observe() {
        const values = db.prepare("SELECT account_id, view_prefs FROM account_preferences ORDER BY account_id").all() as { account_id: string; view_prefs: string }[];
        return { target: values.filter(r => r.account_id === "target").map(r => r.view_prefs), control: values.filter(r => r.account_id === "control").map(r => r.view_prefs) };
      }, dispose() { db.close(); },
    },
    files: {
      populate() { for (const id of ["target", "control"]) writeFileSync(path.join(directory, id), `${id}-bytes`); },
      observe() { const names = readdirSync(directory); return Object.fromEntries(["target", "control"].map(id => [id,
        names.filter(n => n === id).map(n => readFileSync(path.join(directory, n), "utf8"))])) as { target: string[]; control: string[] }; },
      dispose() { rmSync(directory, { recursive: true, force: true }); },
    },
    memory: {
      populate() { memory.set("target", "private turn"); memory.set("control", "other turn"); },
      observe() { return { target: memory.has("target") ? [memory.get("target")!] : [], control: memory.has("control") ? [memory.get("control")!] : [] }; },
      dispose() { memory.clear(); },
    },
    cache: {
      populate() { cache.set("target", "provider answer"); cache.set("control", "unattributed answer"); },
      observe() { return { target: cache.has("target") ? [cache.get("target")!] : [], control: cache.has("control") ? [cache.get("control")!] : [],
        outsideControl: { store: "source-budgets", entries: ["unchanged-source-budget"] } }; },
      dispose() { cache.clear(); },
    },
  };
  return { probes, cleanup() { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); },
    erase(seed?: string) {
      if (seed !== "rows") db.exec("DELETE FROM account_preferences WHERE account_id = 'target'");
      if (seed !== "files") unlinkSync(path.join(directory, "target"));
      if (seed !== "memory") memory.delete("target");
      if (seed === "cache") cache.delete("target"); else cache.clear();
      if (seed === "control") memory.delete("control");
    } };
}
it("accepts populated row, file and retained-memory observations only after target removal and surviving controls", async () => {
  const f = populatedProbes();
  try { expect(await proveErasure(ledger, f.probes, () => f.erase())).toEqual(["rows", "files", "memory", "cache"]); }
  finally { f.cleanup(); }
});
it.each(["rows", "files", "memory", "cache", "control"])("rejects the seeded %s failure using independently observed contents", async seed => {
  const f = populatedProbes();
  try { await expect(proveErasure(ledger, f.probes, () => f.erase(seed))).rejects.toThrow(seed === "cache" ? "Whole cache retained" : seed === "control" ? "Control changed" : "Target retained"); }
  finally { f.cleanup(); }
});
it("refuses an empty target before deletion even when a rule and callback exist", async () => {
  const f = populatedProbes(true), erase = vi.fn();
  try { await expect(proveErasure(ledger, f.probes, erase)).rejects.toThrow("Empty target fixture: rows"); expect(erase).not.toHaveBeenCalled(); }
  finally { f.cleanup(); }
});
it("requires an independent populated control outside a whole-cache purge", async () => {
  const f = populatedProbes(), original = f.probes.cache.observe;
  f.probes.cache.observe = async () => ({ ...await original(), outsideControl: { store: "cache", entries: ["same cache"] } });
  try { await expect(proveErasure(ledger, f.probes, () => f.erase())).rejects.toThrow("Missing outside-cache control"); }
  finally { f.cleanup(); }
});
