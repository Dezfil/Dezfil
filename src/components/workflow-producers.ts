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

const QUALIFIED = /^([a-z][a-z0-9_]*)\.(.+)$/i;

/**
 * A name a step reads, as written in the workflow's home, split into the
 * space it names and the dataset: `<sql name>.<dataset>` is that person's
 * dataset, a plain name the home's (`owner` null) or an output of the
 * workflow itself. The registry's sanitizer must never see the qualified
 * form whole: it would take the dataset part for a file extension.
 */
export function readTarget(name: string): { owner: string | null; name: string } {
  const qualified = QUALIFIED.exec(name.trim());
  return qualified ? { owner: qualified[1].toLowerCase(), name: qualified[2] } : { owner: null, name };
}

/** The key a read answers to: two names key alike only when they name the
 * same dataset as written, so `bo.roads` and `bo.rivers` stay two. */
export function readKey(name: string): string {
  const target = readTarget(name);
  return target.owner === null ? normalName(name) : `${target.owner}.${normalName(target.name)}`;
}

/** The node that produces a read: a qualified name is always external,
 * even when a node's output shares its dataset's name. */
export function producerOf(producer: ReadonlyMap<string, string>, read: string): string | undefined {
  return readTarget(read).owner === null ? producer.get(normalName(read)) : undefined;
}

/** The id a source node carries for a table name. */
export const sourceId = (name: string) => `src:${readKey(name)}`;
