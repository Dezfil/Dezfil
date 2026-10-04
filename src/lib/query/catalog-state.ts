import { registerQueryStore } from "./retained";
import type { ArtifactRelation } from "./artifact-relation";

/** Only immutable artifact projections are cached. A successful view on one
 * connection never proves that another connection mounted anything. A reset
 * retires this cache; late work on an older instance gets an orphan map. */
let generation = -1;
let relations = new Map<string, ArtifactRelation>();
export function artifactRelations(gen: number): Map<string, ArtifactRelation> {
  if (gen > generation) {
    generation = gen;
    relations = new Map();
  }
  return gen === generation ? relations : new Map();
}

export function invalidateArtifactRelations(owner: string | null, name: string): void {
  for (const key of relations.keys()) {
    const [boundOwner, boundName] = JSON.parse(key);
    if (boundOwner === owner && boundName === name) relations.delete(key);
  }
}

registerQueryStore({ drain: async () => {}, busy: () => false, clear() { relations.clear(); relations = new Map(); generation++; } });
export function catalogRelationsForTests(): string[] { return [...relations.keys()]; }
