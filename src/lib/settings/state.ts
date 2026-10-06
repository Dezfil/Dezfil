import type { NumericSettingKey } from "./numeric";

export type NumericOverrides = Readonly<Partial<Record<NumericSettingKey, number>>>;
export type StoreIdentity = string | object;
interface ActiveStore { identity: StoreIdentity; owners: Set<object>; values: NumericOverrides; }

const key = Symbol.for("dezfil.committed-settings");
const host = process as typeof process & { [key]?: {
  active?: ActiveStore;
  listeners: Map<string, () => void>;
} };
const state: NonNullable<typeof host[typeof key]> = host[key] ??= { listeners: new Map() };

/** Pure hot path: neither a database handle nor a loader is consulted. */
export function committedNumericSettings(): NumericOverrides { return state.active?.values ?? {}; }

export function activateCommittedSettings(identity: StoreIdentity, owner: object, values: NumericOverrides): void {
  if (state.active && state.active.identity !== identity) throw new Error("Another settings store is active.");
  if (!state.active) state.active = { identity, owners: new Set(), values: Object.freeze(values) };
  state.active.owners.add(owner);
  publishCommittedSettings(identity, values);
}

export function releaseCommittedSettings(owner: object): void {
  if (!state.active?.owners.delete(owner)) return;
  if (!state.active.owners.size) state.active = undefined;
}

export function publishCommittedSettings(identity: StoreIdentity, values: NumericOverrides): void {
  const active = state.active;
  if (!active || active.identity !== identity) return;
  const previous = active.values;
  if (Object.keys(previous).length === Object.keys(values).length &&
    Object.entries(values).every(([key, value]) => previous[key as NumericSettingKey] === value)) return;
  active.values = Object.freeze(values);
  // Publication has already committed. A listener cannot turn that success
  // into a refused write, or keep another lane from seeing the new state.
  for (const listener of state.listeners.values()) {
    try { listener(); } catch (error) { console.error("Settings listener failed", error); }
  }
}

/** Named subscriptions replace an earlier route bundle's equivalent callback. */
export function onCommittedSettings(name: string, listener: () => void): () => void {
  state.listeners.set(name, listener);
  return () => { if (state.listeners.get(name) === listener) state.listeners.delete(name); };
}
