import type { LineageEdge } from "@/lib/metadata/lineage";
import type { RecipeStep } from "@/lib/metadata/recipes";

/**
 * Staleness.
 *
 * **Every cause is a generation mismatch or a consequence of one.** An edge
 * records the artifact a step actually bound; if the input now holds a different
 * artifact, that step read older data, and no clock is consulted to find out.
 * That matters because clocks cannot answer it: a step that binds P0, has P1
 * published under it, and then finishes has a *later* completion time than its
 * producer while holding the older generation. The artifact says what the
 * timestamps cannot.
 *
 * Three consequences fall out rather than being arranged:
 *
 *  - **Nothing can be lost.** The registry swap that changes an artifact is the
 *    change record. There is no separate mark to fail to write.
 *  - **A change arriving mid-run survives it.** The finishing run writes the
 *    artifact it bound; the table already holds a newer one, so the mismatch is
 *    there the moment it lands.
 *  - **Clearing is exactly scoped.** A re-run rewrites its edges against current
 *    artifacts, so the causes it answered disappear and an unresolved upstream
 *    does not.
 *
 * **Every active cause is reported**, each naming its source. A step can read a
 * refreshed table *and* sit downstream of a re-run step, and discarding one to
 * show the other would leave the API unable to say why an output is stale.
 */

export type StaleReasonKind =
  | "source_changed"
  | "upstream_stale"
  | "upstream_re_ran";

export interface StaleCause {
  reason: StaleReasonKind;
  /** The table this cause came from. */
  tableId: string;
  tableName: string;
  /** The step that produces that table, when one does. */
  producedByStepId?: string;
}

/** What the derivation needs to know about the world, supplied by the caller
 * so the rule itself stays pure and exhaustively testable. */
export interface StalenessInput {
  steps: RecipeStep[];
  /** Every edge belonging to the steps above. */
  edges: LineageEdge[];
  /** The artifact each table currently holds; absent means the table is gone. */
  currentArtifact: Map<string, string>;
}

/** Which step, if any, produces each output table id. */
function producers(steps: RecipeStep[]): Map<string, RecipeStep> {
  const byOutput = new Map<string, RecipeStep>();
  for (const s of steps) if (s.outputTableId) byOutput.set(s.outputTableId, s);
  return byOutput;
}

/**
 * Every active cause for every step, keyed by step id.
 *
 * Computed for the whole recipe at once because `upstream_stale` is recursive:
 * a step is upstream-stale when a producer it reads is stale for any reason,
 * including being upstream-stale itself. Steps are visited in order, which is
 * sound precisely because dependencies may only point backwards — the property
 * enforced at edit time is what makes one pass enough here.
 */
export function deriveStaleness(input: StalenessInput): Map<string, StaleCause[]> {
  const { steps, edges, currentArtifact } = input;
  const byProducer = producers(steps);
  const edgesByStep = new Map<string, LineageEdge[]>();
  for (const e of edges) {
    const list = edgesByStep.get(e.stepId);
    if (list) list.push(e);
    else edgesByStep.set(e.stepId, [e]);
  }

  const causes = new Map<string, StaleCause[]>();
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);

  for (const step of ordered) {
    const found: StaleCause[] = [];
    // A step that has never produced anything is not stale; it is *never run*,
    // which is a different condition and not this function's to report.
    if (step.outputTableId === null) {
      causes.set(step.id, found);
      continue;
    }

    for (const edge of edgesByStep.get(step.id) ?? []) {
      const producer = byProducer.get(edge.inputTableId);
      const now = currentArtifact.get(edge.inputTableId);

      // A vanished input is *broken*, not stale — the step cannot run at all,
      // and saying "out of date" about it would offer a re-run that fails.
      if (now === undefined) continue;

      if (now !== edge.boundArtifact) {
        found.push({
          reason: producer ? "upstream_re_ran" : "source_changed",
          tableId: edge.inputTableId,
          tableName: edge.inputTableName,
          ...(producer ? { producedByStepId: producer.id } : {}),
        });
        // Deliberately **not** `continue`. A producer that re-ran can also be
        // stale itself — it re-ran, and then one of *its* inputs moved — and
        // both causes are then true of this step. Stopping at the first would
        // report one of two, which is the single-reason model this spec's own
        // gate rejected.
      }

      // The step that made this input may itself be stale, whichever generation
      // of it this one bound.
      if (producer && (causes.get(producer.id)?.length ?? 0) > 0) {
        found.push({
          reason: "upstream_stale",
          tableId: edge.inputTableId,
          tableName: edge.inputTableName,
          producedByStepId: producer.id,
        });
      }
    }

    causes.set(step.id, found);
  }

  return causes;
}

/** The causes for one step, for callers that hold the whole derivation. */
export function causesFor(
  derived: Map<string, StaleCause[]>,
  stepId: string,
): StaleCause[] {
  return derived.get(stepId) ?? [];
}

/** Whether a step is stale at all. */
export function isStale(
  derived: Map<string, StaleCause[]>,
  stepId: string,
): boolean {
  return causesFor(derived, stepId).length > 0;
}
