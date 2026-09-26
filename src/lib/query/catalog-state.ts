/**
 * What the process knows it bound into the hardened catalog: per table
 * name, the identity and artifact whose CREATE VIEW actually succeeded.
 * The registration pass consults this to skip tables whose binding
 * cannot have changed — a refresh keeps the name but swaps the
 * artifact, and a reclaimed name changes identity, so both re-register.
 * Only success is remembered: a failed registration leaves no entry and
 * therefore retries on the next pass.
 *
 * The memory belongs to a catalog generation, never to the process. A
 * newer generation swaps in fresh memory lazily; a pass still working
 * for a discarded catalog is handed an orphan map, because its late
 * recordings describe a catalog nobody will query again and must not
 * mark the replacement current (the plan's counter-ordering: a pass
 * acquires its connection before joining the serialized chain, so it
 * can outlive a reset).
 */

export interface TableBinding {
  id: string;
  file: string;
  geometryColumn: string | null;
}

let generation = -1;
let bindings = new Map<string, TableBinding>();

export function catalogBindings(gen: number): Map<string, TableBinding> {
  if (gen > generation) {
    generation = gen;
    bindings = new Map();
  }
  return gen === generation ? bindings : new Map();
}
