import { inspect } from "node:util";

/**
 * A key a provider's words carry back is taken out before those words reach a
 * person, a record or a log. Providers do echo what they were sent: a rejected
 * key in an error body, a request echoed by a proxy.
 */

const MASK = "[key removed]";

export function scrubKey(text: string, key: string): string {
  if (!key) return text;
  const encoded = encodeURIComponent(key);
  const once = text.split(key).join(MASK);
  return encoded === key ? once : once.split(encoded).join(MASK);
}

/** The same failure, unless anything it would print holds the key: then a bare
 * error with the message cleaned, since a stack or a cause cannot be cleaned in
 * place and the funnels print them whole. */
export function scrubbedError(error: unknown, key: string): unknown {
  const printed = inspect(error, { depth: 6 });
  if (!printed.includes(key) && !printed.includes(encodeURIComponent(key))) return error;
  const cleaned = new Error(scrubKey(error instanceof Error ? error.message : String(error), key));
  cleaned.name = error instanceof Error ? error.name : "Error";
  delete cleaned.stack;
  return cleaned;
}
