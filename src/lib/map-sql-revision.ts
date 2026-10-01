/**
 * A map's SQL revision: one short token over its layers' identities and SQL,
 * in layer order. The builder takes it from the map it holds when a card
 * capture starts and sends it with the image; the server computes it again
 * from the stored layers, so an image whose layers moved before it arrived is
 * recognized as not attributable to the SQL the map now holds.
 *
 * Shared by the browser and the server, so it uses no platform hashing. It
 * guards against honest races, not a forger: the only uploader is the map's
 * owner, who could send any image anyway.
 */
export interface RevisionLayer {
  id: string;
  sql: string;
}

const REVISION_SHAPE = /^[0-9a-f]{16}$/;

export function isMapSqlRevision(value: unknown): value is string {
  return typeof value === "string" && REVISION_SHAPE.test(value);
}

/** Two independent 32-bit mixes over the UTF-16 text, as 16 hex digits. */
export function mapSqlRevision(layers: readonly RevisionLayer[]): string {
  const text = JSON.stringify(layers.map((layer) => [layer.id, layer.sql]));
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(b)}${hex(a)}`;
}
