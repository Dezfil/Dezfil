import { deriveTableName } from "@/lib/ingest/naming";
import type { WorkflowStep } from "./workflow-model";

/**
 * Which node answers to a name: a node is found by every name it answers
 * to — what it produced, what its active definition declares, and what a
 * pending edit would rename it to — so a downstream read may name any of
 * the three. Shared by the list's thumbnail and the canvas so both
 * surfaces resolve reads the same way.
 *
 * The normalization **is the registry's**: the sanitizer the materializer
 * applies to a declared name ("2024 Trips" registers as `t2024_trips`),
 * imported rather than mirrored so the two cannot drift — a copy here
 * once did, and drew a produced table as a missing external source.
 */
const NONE: ReadonlySet<string> = new Set();
export function normalName(name: string): string {
  return deriveTableName(name.trim(), NONE);
}

/** Every name a node answers to, normalized → the node's id, in recipe
 * order so a later node's claim wins as it would in a run. */
export function producersByName(steps: WorkflowStep[]): Map<string, string> {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const producer = new Map<string, string>();
  for (const s of ordered) {
    const names = [
      s.output?.name,
      s.parameters.name,
      s.proposedParameters?.name,
    ].filter((n): n is string => typeof n === "string" && n !== "");
    for (const n of names) producer.set(normalName(n), s.id);
  }
  return producer;
}

/** The id a source node carries for a table name. */
export const sourceId = (name: string) => `src:${normalName(name)}`;
