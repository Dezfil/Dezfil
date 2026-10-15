import { createHash } from "node:crypto";
import { registerQueryStore } from "@/lib/query/retained";
import { inputsKey, type ArtifactInputs } from "@/lib/query/evaluation-inputs";

/**
 * Layer answers known to exceed Bytes drawn per layer.
 *
 * A layer learns that its inline answer is over the limit only by reading
 * it up to the limit. The builder asks for a tiled layer's render every few
 * seconds while its tiles build, and every reload or published view asks
 * again, so each ask would read the same answer up to the limit before
 * taking the same road. The outcome is remembered for the answer it was
 * read for: the layer, its effective query (filters included), the fields
 * it carries, its envelope, the data its evaluation read (keyed as the
 * tile archive keys its freshness) and the limit. Anything that could
 * change the answer is a different key, read afresh. Only refusals are
 * remembered; an answer that fits is read every time, as it is drawn.
 */

/** The most answers remembered; the oldest is forgotten first. */
const CAPACITY = 256;

const remembered = new Map<string, true>();

export interface OverLimitAnswer {
  layerId: string;
  /** The FROM clause the answer is read from: the effective query. */
  from: string;
  /** The property columns the answer carries, in order. */
  properties: readonly string[];
  /** Whatever else the envelope carries that the data does not decide. */
  envelope: unknown;
  inputs: ArtifactInputs;
  limit: number;
}

function keyOf(answer: OverLimitAnswer): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([answer.from, answer.properties, answer.envelope, inputsKey(answer.inputs), answer.limit]))
    .digest("hex");
  return `${answer.layerId}\u0000${digest}`;
}

/** Whether this answer was read before and refused at this limit. */
export function knownOverLimit(answer: OverLimitAnswer): boolean {
  const key = keyOf(answer);
  if (!remembered.has(key)) return false;
  remembered.delete(key);
  remembered.set(key, true);
  return true;
}

export function rememberOverLimit(answer: OverLimitAnswer): void {
  const key = keyOf(answer);
  remembered.delete(key);
  remembered.set(key, true);
  while (remembered.size > CAPACITY) remembered.delete(remembered.keys().next().value!);
}

registerQueryStore({ drain: async () => {}, busy: () => false, clear: () => remembered.clear() });

/** The layers with a remembered refusal, one entry per answer. */
export function overLimitLayersForTests(): string[] {
  return [...remembered.keys()].map((key) => key.split("\u0000")[0]);
}
