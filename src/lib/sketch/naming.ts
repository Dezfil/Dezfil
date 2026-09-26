/**
 * Sketch dataset naming: normalize the MAP NAME first, then append
 * `_sketch`. The standing filename deriver strips a trailing `.ext`, which
 * would eat part of a map name like "Map v1.2" — so the normalization here
 * applies the same character rules without the extension rule. The result
 * is handed to the standing derive-and-register road, whose collision
 * advance (`_2`, `_3`, …) is the visible suffix the spec names; no dot
 * survives normalization, so that road's extension stripping can never
 * bite.
 */

export function sketchBaseName(mapName: string): string {
  const stem = mapName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(?=[0-9])/, "t");
  return `${stem || "map"}_sketch`;
}
