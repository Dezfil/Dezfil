import type { GeometryCandidate } from "@/lib/geometry-evidence";
import { lonLatPairs } from "@/lib/od";
import { isNumericCsvType, type CsvColumn } from "./csv-geometry";
import { crsEvidence } from "./content-decoders";

function fits(x: unknown, y: unknown): boolean {
  return Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Math.abs(Number(x)) <= 180 && Math.abs(Number(y)) <= 90;
}

/** Range-only evidence never auto-applies. Each unordered pair appears once. */
export function sampledPairs(columns: readonly CsvColumn[], rows: Record<string, unknown>[]): GeometryCandidate[] {
  const numeric = columns.filter(c => isNumericCsvType(c.type));
  const named = lonLatPairs(numeric.map(c => c.name)).map(p => ({ lon: p.lon, lat: p.lat }));
  const byLower = new Map(numeric.map(c => [c.name.toLowerCase(), c.name]));
  if (byLower.has("easting") && byLower.has("northing")) named.push({ lon: byLower.get("easting")!, lat: byLower.get("northing")! });
  const out: GeometryCandidate[] = [];
  for (let i = 0; i < numeric.length; i++) for (let j = i + 1; j < numeric.length; j++) {
    const a = numeric[i].name, b = numeric[j].name;
    const complete = rows.filter(r => r[a] !== null && r[b] !== null);
    const name = named.find(p => (p.lon === a && p.lat === b) || (p.lon === b && p.lat === a));
    const possible = name ? [name] : [{ lon: a, lat: b }, { lon: b, lat: a }];
    const shares = possible.map(p => complete.filter(r => fits(r[p.lon], r[p.lat])).length);
    const readable = Math.max(...shares);
    if (!name && (!complete.length || readable / complete.length < 0.5)) continue;
    if (!complete.length) continue;
    const orientations = name ? possible : possible.filter((_, k) => shares[k] / complete.length >= 0.5);
    out.push({
      columns: [a, b], format: "pair", signal: "content", rule: "content", strength: "weak",
      sample: { rows: rows.length, nonNull: complete.length, readable },
      crs: crsEvidence("pair", []), degreeCompatible: readable === complete.length,
      reasons: [...(readable !== complete.length ? ["outside-degree-range"] : []), orientations.length > 1 ? "ambiguous-axes" : "numeric-pair-only"],
      orientations, applied: false, sourceRetained: true,
    });
  }
  return out;
}

export function orderCandidates(candidates: GeometryCandidate[], columns: readonly CsvColumn[]): GeometryCandidate[] {
  const index = new Map(columns.map((c, i) => [c.name, i]));
  const named = lonLatPairs(columns.map(c => c.name));
  const isNamed = (c: GeometryCandidate) => c.format === "pair" &&
    (c.signal === "name" || named.some(p => c.columns.includes(p.lon) && c.columns.includes(p.lat)) ||
      c.columns.map(n => n.toLowerCase()).sort().join("/") === "easting/northing");
  const category = (c: GeometryCandidate) => c.applied ? -1 : c.sample.readable === null ? 4 : c.strength === "strong" ? 0 : c.format !== "pair" ? 1 : isNamed(c) ? 2 : 3;
  const share = (c: GeometryCandidate) => c.sample.nonNull ? (c.sample.readable ?? 0) / c.sample.nonNull : 0;
  const adjacent = (c: GeometryCandidate) => c.columns.length === 2 && Math.abs(index.get(c.columns[0])! - index.get(c.columns[1])!) === 1 ? 0 : 1;
  return candidates.sort((a, b) => category(a) - category(b) ||
    (a.strength === "strong" && b.strength === "strong" ? 0 : share(b) - share(a) || adjacent(a) - adjacent(b)) ||
    index.get(a.columns[0])! - index.get(b.columns[0])! ||
    (index.get(a.columns[1]) ?? -1) - (index.get(b.columns[1]) ?? -1));
}
