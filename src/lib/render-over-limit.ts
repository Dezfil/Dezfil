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
 *
 * A query can also change its answer with none of that changing: one that
 * reads the clock (now(), a time window) or draws random rows returns
 * less later. So a refusal is remembered for a fixed time from the read
 * that found it, and asking again does not extend it. Thirty seconds
 * spares a dozen of the builder's polls, 2.5 s apart, and the renders a
 * reload or a published view makes around them, while an answer that has
 * come to fit is drawn again within half a minute.
 */

/** The most answers remembered; the oldest read is forgotten first. */
const CAPACITY = 256;
/** How long a refusal is remembered from the read that found it. */
const LIFETIME_MS = 30_000;

/** Each remembered refusal, by its key, with when it was read. */
const remembered = new Map<string, number>();

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

/** Whether this answer was read and refused at this limit within the
 * lifetime. A clock that went back counts as the lifetime passed. */
export function knownOverLimit(answer: OverLimitAnswer): boolean {
  const key = keyOf(answer);
  const read = remembered.get(key);
  if (read === undefined) return false;
  const age = Date.now() - read;
  if (age >= 0 && age < LIFETIME_MS) return true;
  remembered.delete(key);
  return false;
}

export function rememberOverLimit(answer: OverLimitAnswer): void {
  const key = keyOf(answer);
  remembered.delete(key);
  remembered.set(key, Date.now());
  while (remembered.size > CAPACITY) remembered.delete(remembered.keys().next().value!);
}

registerQueryStore({ drain: async () => {}, busy: () => false, clear: () => remembered.clear() });

/** The layers with a remembered refusal, one entry per answer. */
export function overLimitLayersForTests(): string[] {
  return [...remembered.keys()].map((key) => key.split("\u0000")[0]);
}
