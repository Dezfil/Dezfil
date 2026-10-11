/**
 * What no template may carry, wherever it sits in a document: a
 * publication, a token, a connection, a service address or a setting.
 *
 * The write roads hold a document's shape; this is the reader's one rule
 * of its own, because a template is a document from outside that a copy
 * turns into someone's work, and none of these may arrive that way. A
 * publication is the owner's act on their own server, a token or a
 * connection is a credential, a service address is something this server
 * would reach on the template's say, and a setting is the admin's.
 *
 * A field present with nothing in it (null, false, an empty string, list
 * or object) carries nothing and passes: the export writes some of these
 * empty on every map.
 */

type Carried = "a publication" | "a token" | "a connection" | "a service address" | "a setting";

/** A configuration constant, never changed: what each forbidden key carries. */
const FORBIDDEN_KEYS: Readonly<Record<string, Carried>> = {
  publishToken: "a publication",
  publishedAt: "a publication",
  published: "a publication",
  publication: "a publication",
  token: "a token",
  apiToken: "a token",
  accessToken: "a token",
  secret: "a token",
  password: "a token",
  apiKey: "a token",
  connection: "a connection",
  connectionId: "a connection",
  connections: "a connection",
  customBasemap: "a service address",
  libraryStyle: "a service address",
  settings: "a setting",
  setting: "a setting",
};

/** A key naming an address the server or a browser would reach. */
const ADDRESS_KEY = /(?:url|uri|endpoint|href)$/i;

function empty(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/**
 * The first forbidden field in a document, worded for the refusal, or null.
 * `where` names the document for the message.
 */
export function forbiddenContent(document: unknown, where: string): string | null {
  const stack: { value: unknown; at: string }[] = [{ value: document, at: "" }];
  while (stack.length > 0) {
    const { value, at } = stack.pop()!;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], at: `${at}[${i}]` });
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries) {
      const carried = (Object.hasOwn(FORBIDDEN_KEYS, key) ? FORBIDDEN_KEYS[key] : undefined)
        ?? (ADDRESS_KEY.test(key) ? "a service address" : undefined);
      if (carried && !empty(child)) {
        const field = at ? `${at}.${key}` : key;
        return `${where} carries ${carried} (${field}), which no template may hold.`;
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, child] = entries[i];
      stack.push({ value: child, at: at ? `${at}.${key}` : key });
    }
  }
  return null;
}
