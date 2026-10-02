/**
 * The 16-C archive's pure pieces: the naming rule — shared verbatim
 * by the dialog and the server so the field, the tree, the download
 * name and the archive root cannot disagree — and the projections,
 * which turn the documented wire shapes into the bundle's portable
 * documents. Both are recorded provisional in the queue: with no
 * importer shipped, the format binds no consumer yet. This module stays
 * dependency-free so client code can import it.
 */

/** The reference's file form: lowercase, runs of non-alphanumerics to
 * one hyphen, trimmed — and the ruled `project` fallback when nothing
 * survives. */
export function archiveBaseName(name: string): string {
  return slug(name) || "project";
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Member file base names, per folder: the slug of each member's name
 * in the server's listing order, collisions suffixed ordinally in that
 * same order (never the caller's array order — the preflight restores
 * the canonical order first). An empty file form falls to `untitled`
 * and collides like any other name. */
export function memberFileNames(names: string[]): string[] {
  // Every EMITTED name is tracked, not just each base's count: with
  // names slugging to "map", "map" and "map-2", counting bases alone
  // would emit "map-2" twice — the suffix advances
  // until the candidate is genuinely unused.
  const used = new Set<string>();
  return names.map((name) => {
    const base = slug(name) || "untitled";
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
    used.add(candidate);
    return candidate;
  });
}

/** The map document: the documented map-with-layers facts, its owner
 * and SQL home included, minus publication STATE — the fact, the
 * credential, the timestamp
 * ("Publishing belongs to this server", the ruled callout) — and minus
 * project membership (the archive's own structure carries it). The
 * authored publication CONTROLS (publishedFields, widgetsPublished)
 * are the author's definition and stay. */
export function mapProjection(wire: Record<string, unknown>): object {
  const kept = { ...wire };
  delete kept.publishToken;
  delete kept.publishedAt;
  delete kept.published;
  delete kept.projectId;
  return kept;
}

interface WorkflowStepWire {
  id: unknown;
  ordinal: unknown;
  operation: unknown;
  parameters: unknown;
  origin: unknown;
}

/** The workflow document: an explicit allow-list of definition
 * facts — identity, name, origin, its SQL home, timestamps, and each node's own
 * definition — with the documented layout payload as its annex, and
 * none of the wire's interleaved runtime (status, outputs, conditions,
 * causes, missing inputs, lineage, attempts, success times) or its
 * membership. */
export function workflowProjection(
  wire: {
    id: unknown;
    name: unknown;
    origin: unknown;
    home?: unknown;
    createdAt: unknown;
    updatedAt: unknown;
    steps: Record<string, unknown>[];
  },
  layout: unknown,
): object {
  return {
    id: wire.id,
    name: wire.name,
    origin: wire.origin,
    // The SQL home its steps' plain names mean.
    home: wire.home,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    steps: wire.steps.map(
      (s): WorkflowStepWire => ({
        id: s.id,
        ordinal: s.ordinal,
        operation: s.operation,
        parameters: s.parameters,
        origin: s.origin,
      }),
    ),
    layout,
  };
}
