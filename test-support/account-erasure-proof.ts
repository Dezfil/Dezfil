import type { Discovery } from "./account-erasure-discovery";

export interface ErasureInventory {
  stores: Record<string, { action: string; rule: string; fixture?: string }>;
  tables: Record<string, string>;
  sources: Record<string, { stores: string[]; roots?: string[] }>;
  files: Record<string, string[]>;
  accountReferences: Record<string, string>;
  identityColumns: Record<string, string>;
}
function differences(actual: string[], declared: string[], kind: string): string[] {
  return [...actual.filter(id => !declared.includes(id)).map(id => `Unclassified ${kind}: ${id}`),
    ...declared.filter(id => !actual.includes(id)).map(id => `Stale ${kind}: ${id}`)];
}
/** Forward AND reverse checks: a fictitious declaration never closes a gap. */
export function inventoryProblems(discovery: Discovery, inventory: ErasureInventory): string[] {
  const sources = discovery.sources.filter(s => s.classification === "server");
  const problems = [
    ...differences(discovery.tables, Object.keys(inventory.tables), "table"),
    ...differences(sources.map(s => s.id), Object.keys(inventory.sources), "source"),
    ...differences(discovery.accountReferences, Object.keys(inventory.accountReferences), "account foreign key"),
    ...differences(discovery.identityColumns, Object.keys(inventory.identityColumns), "identity column"),
  ];
  for (const source of sources) {
    const entry = inventory.sources[source.id];
    if (entry && JSON.stringify(source.roots) !== JSON.stringify(entry.roots)) problems.push(`Changed location: ${source.id}`);
  }
  for (const [key, role] of Object.entries(inventory.accountReferences)) {
    if (!["owner", "member", "actor", "sql-home", "adoption"].includes(role)) problems.push(`Invalid account foreign key role: ${key}`);
  }
  const retained = Object.keys(inventory.identityColumns).filter(k => inventory.identityColumns[k] === "retain").sort();
  if (JSON.stringify(retained) !== JSON.stringify(["id", "sql_name", "status"])) problems.push("Retained identity must be exactly id, sql_name and status");
  const used = [...Object.values(inventory.tables), ...Object.values(inventory.sources).flatMap(s => s.stores), ...Object.keys(inventory.files)];
  problems.push(...differences([...new Set(used)], Object.keys(inventory.stores), "store rule"));
  for (const [id, rule] of Object.entries(inventory.stores)) {
    if (!["erase", "purge", "compact", "retain"].includes(rule.action) || !rule.rule.trim()) problems.push(`Missing consequence: ${id}`);
    if (rule.action !== "retain" && !rule.fixture) problems.push(`Missing populated fixture obligation: ${id}`);
  }
  return problems.sort();
}
export function fileMatches(file: string, pattern: string): boolean {
  const expression = pattern.split("**").map(part => part.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${expression}$`).test(file);
}
export function fileProblems(files: string[], inventory: ErasureInventory): string[] {
  const rules = Object.entries(inventory.files);
  return [
    ...files.filter(file => !rules.some(([, patterns]) => patterns.some(p => fileMatches(file, p)))).map(f => `Unclassified file: ${f}`),
    ...rules.filter(([, patterns]) => !files.some(f => patterns.some(p => fileMatches(f, p)))).map(([id]) => `Unpopulated file store: ${id}`),
  ];
}

export interface StoreObservation {
  /** Stable entry identities read independently of the cleanup's capture. */
  target: readonly string[];
  control: readonly string[];
  /** Whole-cache controls must be in a separately named, unpurged store. */
  outsideControl?: { store: string; entries: readonly string[] };
}
export interface ErasureProbe {
  populate(): void | Promise<void>;
  observe(): StoreObservation | Promise<StoreObservation>;
  dispose(): void | Promise<void>;
}
/** Each fixture observes its real store, not a service-reported deletion count.
 * No fallback, empty target or missing binding can produce completion evidence.
 * Bind the full coordinator here when cleanup is delivered; a rule alone is
 * deliberately insufficient. Partial cleanup stages pass an explicit subinventory. */
export async function proveErasure(inventory: ErasureInventory, probes: Record<string, ErasureProbe>, erase: () => void | Promise<void>): Promise<string[]> {
  const required = Object.entries(inventory.stores).filter(([, s]) => s.action !== "retain");
  const missing = required.filter(([id]) => !probes[id]).map(([id]) => `Missing populated probe: ${id}`);
  if (missing.length) throw new Error(missing.join("\n"));
  const before = new Map<string, StoreObservation>(), populated: ErasureProbe[] = [];
  try {
    for (const [id, rule] of required) {
      const probe = probes[id]; populated.push(probe); await probe.populate();
      const value = structuredClone(await probe.observe());
      if (!value.target.length) throw new Error(`Empty target fixture: ${id}`);
      if (!value.control.length) throw new Error(`Empty control fixture: ${id}`);
      if (rule.action === "purge" && (!value.outsideControl?.entries.length || value.outsideControl.store === id))
        throw new Error(`Missing outside-cache control: ${id}`);
      before.set(id, value);
    }
    await erase();
    for (const [id, rule] of required) {
      const was = before.get(id)!, now = await probes[id].observe();
      if (now.target.length) throw new Error(`Target retained: ${id}`);
      if (rule.action === "purge") {
        if (now.control.length) throw new Error(`Whole cache retained: ${id}`);
        if (JSON.stringify(now.outsideControl) !== JSON.stringify(was.outsideControl)) throw new Error(`Outside control changed: ${id}`);
      } else if (JSON.stringify(now.control) !== JSON.stringify(was.control)) throw new Error(`Control changed: ${id}`);
    }
    return required.map(([id]) => id);
  } finally { for (const probe of populated.reverse()) await probe.dispose(); }
}
