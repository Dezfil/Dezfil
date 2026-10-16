/*
 * The assignment of an inner ring to an outer ring (`outerOf`) and the
 * crossing rule it applies (`inRing`) are adapted from osmtogeojson
 * 3.0.0-beta.5 (index.js, `findOuter` and its point-in-polygon test),
 * which takes them from the iD editor's relation.js and geo.js; iD bases
 * its test on substack's point-in-polygon and W. Randolph Franklin's
 * pnpoly. The osmtogeojson notice follows, then iD's.
 *
 * Copyright (c) 2013 Martin Raifer
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * iD (https://github.com/openstreetmap/iD), ISC License:
 *
 * Copyright (c) iD Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for
 * any purpose with or without fee is hereby granted, provided that the
 * above copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
 * WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR
 * BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES
 * OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
 * WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
 * SOFTWARE.
 */

import osmtogeojson from "osmtogeojson";
import { jsonBytes } from "@/lib/query/result-budget";
import { FULL_GEOMETRY, interesting, readAssemblerModel, type AssemblerModel, type ModelFeature, type Raw, type TableRelation, type TableWay } from "./assembler-model";
import { joinRuns, KEPT_RING } from "./assembler-rings";
import { pairBytes, propertiesWithoutTags, textInStringBytes } from "./feature-bytes";
import { pointWithin, type BuiltFeature, type WithinShape } from "./geometry";

/**
 * How an OpenStreetMap preview is assembled so that no line or polygon too
 * large for the answer on its own is built.
 *
 * The assembler builds each feature whole, every coordinate pair and its
 * tags, before handing it over. So every line and polygon that might not
 * fit beside the smallest envelope the answer can have is first measured
 * from the raw response, to the byte: the coordinates of every node it
 * will hold, each number in its own spelling, and its tags with their
 * escaping. Each one that does not fit is then assembled from a stand-in:
 * the same element with only the few nodes that keep what the assembler
 * decides about it, whether it makes a feature, its geometry class and
 * whether it lies inside the area the preview is limited to. Everything
 * else the assembler reads is left as it was, so every other feature, and
 * the order in which the features come, is unchanged. The stand-in
 * carries the measured size, and the preview places it as it would place
 * the feature: if the answer would hold it, the preview is refused; if the
 * cap or a later line leaves it out, the answer is the one the whole
 * response gives. A point is built from its one pair and holds its tags
 * as they are, so it is measured when it comes back.
 *
 * What a stand-in keeps:
 * - a way: its first and last nodes (whether it closes into a ring), two
 *   nodes the assembler finds (whether it makes a line at all), and the
 *   first node outside the area;
 * - a route: the first node outside the area;
 * - a multipolygon whose outer rings settle it: of each outer way, its
 *   ends and two more nodes, so that the ways join into the same rings and
 *   each ring keeps or loses its fourth node, and the first node outside
 *   the area.
 * A way read only by stood-in features is reduced in place, keeping too
 * every node another way names and every node the assembler may draw as a
 * point of its own. So is a way whose own line is stood in for: a
 * relation that is not, and reads the way, reads a whole copy of it
 * instead. A relation stood in for that reads a way another feature also
 * reads gets its own reduced copy of that way.
 *
 * Assembled whole, as before: responses of a shape Overpass does not
 * write, a node whose position differs from one element to the next, a
 * feature the preview could not tell apart from another when it comes
 * back, a multipolygon drawn only from inner rings or one whose inner
 * rings alone decide whether it lies in the area, and a relation whose
 * copy would leave a way it alone marks as skipped drawn on its own. A
 * member's way that the assembler draws as a line of its own, which a
 * relation not stood in for also reads, is read whole by that line's
 * stand-in.
 */
export interface PreviewPlan {
  /** The response the assembler is given. */
  response: unknown;
  /** The measured size of a feature that comes from a stand-in, or null. */
  sized(feature: BuiltFeature): number | null;
  /** Whether a feature is drawn only from a copy the plan added, and so is
   * no feature of the response. */
  added(feature: BuiltFeature): boolean;
}

const ANONYMOUS = "_anonymous@";
const UNKNOWN_LOCATION = "_anonymous@unknown_location";
/** At most a coordinate pair's size with its separator: two numbers of at
 * most 25 characters, two brackets and two commas. */
const PAIR_MOST = 54;
/** Marks the tags of an element stood in for with the size of its
 * feature. A symbol that is not enumerable: the assembler's tag tests,
 * its copies and serialization never see it. */
const MARK = Symbol("stood-in feature size");

/** A member's role that an area neither draws nor counts as outer. */
const GIVEN = "given";

const geometryFrame = (type: string) => `{"type":"${type}","coordinates":}`.length;

type Key = string | number;

/** A node the assembler names by its numeric id. */
interface NodeFacts {
  /** Elements that give the node a position. */
  count: number;
  lon: number;
  lat: number;
  /** Whether every position given is the same pair of numbers. */
  sure: boolean;
  /** Whether the assembler may draw it as a point of its own. */
  point: boolean;
  /** The node elements that give it. */
  nodes: Raw[];
  /** The way elements that name it. */
  ways: Set<TableWay>;
}

/** The nodes of the ways the plan reads, position by position. */
interface NodeStore {
  base: Map<TableWay, number>;
  way: TableWay[];
  at: number[];
  key: (Key | undefined)[];
  lon: number[];
  lat: number[];
  found: boolean[];
  sure: boolean[];
  /** A node the assembler may draw as a point, or another way names. */
  held: boolean[];
  facts: Map<number, NodeFacts>;
}

/** How many features the preview would take for one it recognises. */
interface Recognition {
  /** Simple areas by the way element whose tags they carry. */
  simple: Map<Raw, number>;
  /** Lines and areas with empty tags, by their id. */
  lines: Map<string, number>;
  areas: Map<string, number>;
}

interface StandIn {
  feature: ModelFeature;
  bytes: number;
  /** Positions each way must keep for the feature to stay what it is. */
  keeps: Map<TableWay, Set<number>>;
}

const waysOf = (feature: ModelFeature): TableWay[] => (feature.way ? [feature.way] : feature.members.map((m) => m.way));

export function planPreview(response: unknown, promoted: string[], within: WithinShape | null, room: number): PreviewPlan {
  const whole: PreviewPlan = { response, sized: () => null, added: () => false };
  const model = readAssemblerModel(response);
  if (!model) return whole;
  const candidates = model.features.filter((feature) =>
    upperBound(feature, promoted) > room && waysOf(feature).every((way) => way.kind !== "bounds"));
  if (candidates.length === 0) return whole;
  const store = readNodes(model, candidates);
  if (!store) return whole;
  const known = recognition(model);
  const standIns: StandIn[] = [];
  for (const feature of candidates) {
    const standIn = standInFor(feature, store, known, promoted, within, room);
    if (standIn) standIns.push(standIn);
  }
  return standIns.length ? standInPlan(response, model, store, standIns) : whole;
}

/** A size no feature can exceed: every pair and every tag character at
 * its longest. */
function upperBound(feature: ModelFeature, promoted: string[]): number {
  const tags: Raw = feature.tags ?? {};
  let bytes = 128 + 6 * (feature.id.length + feature.type.length);
  for (const [name, value] of Object.entries(tags)) bytes += 7 * (name.length + (value as string).length) + 12;
  for (const name of promoted) {
    const value = tags[name];
    bytes += 6 * name.length + 8 + (value === undefined || value === null ? 4 : 6 * String(value).length);
  }
  for (const way of waysOf(feature)) bytes += PAIR_MOST * way.length + 8;
  return bytes;
}

/** A pair of numbers read once from a raw position, or null. */
function readPair(at: unknown): { lon: number; lat: number } | null {
  if (!at || typeof at !== "object") return null;
  const lon = (at as Raw).lon;
  const lat = (at as Raw).lat;
  return typeof lon === "number" && typeof lat === "number" ? { lon, lat } : null;
}

/**
 * Reads the nodes of every way the candidates are built from, each
 * coordinate once: a member's geometry and a way's geometry named by
 * coordinates hold their own positions; a way that names its nodes by id
 * finds them wherever the response gives them.
 */
function readNodes(model: AssemblerModel, candidates: ModelFeature[]): NodeStore | null {
  const store: NodeStore = { base: new Map(), way: [], at: [], key: [], lon: [], lat: [], found: [], sure: [], held: [], facts: new Map() };
  const read = new Set<TableWay>();
  for (const feature of candidates) for (const way of waysOf(feature)) read.add(way);
  const wanted = (id: number) => {
    if (!store.facts.has(id)) store.facts.set(id, { count: 0, lon: NaN, lat: NaN, sure: true, point: false, nodes: [], ways: new Set() });
  };
  for (const way of read) {
    if (way.kind === "way" && Array.isArray(way.raw.nodes)) for (const id of way.raw.nodes as number[]) wanted(id);
  }
  // The centre of an element that carries a feature is a node named by the
  // element's id, whose tags would be merged with any other such node's.
  for (const feature of candidates) if (feature.carrier?.center) wanted(feature.carrier.id as number);

  const give = (id: number, at: unknown, point: boolean, node?: Raw) => {
    const facts = store.facts.get(id);
    if (!facts) return;
    const pair = readPair(at);
    if (!pair) facts.sure = false;
    else if (facts.count === 0) { facts.lon = pair.lon; facts.lat = pair.lat; }
    else if (facts.lon !== pair.lon || facts.lat !== pair.lat) facts.sure = false;
    facts.count++;
    if (point) facts.point = true;
    if (node) facts.nodes.push(node);
  };
  const relations = new Map<Raw, TableRelation>(model.relations.map((relation) => [relation.raw, relation]));
  if (store.facts.size) {
    for (const element of model.elements) {
      if (element.type === "node") {
        give(element.id as number, element, element.tags !== undefined && interesting(element.tags as Raw), element);
      } else if (element.type === "way") {
        if (element.center) give(element.id as number, element.center, true);
        const ids = element.nodes;
        if (!Array.isArray(ids)) continue;
        const geometry = Array.isArray(element.geometry) ? (element.geometry as unknown[]) : null;
        const way = model.table.get(String(element.id))!;
        for (let i = 0; i < ids.length; i++) {
          const facts = store.facts.get(ids[i] as number);
          if (!facts) continue;
          facts.ways.add(way);
          if (geometry?.[i]) give(ids[i] as number, geometry[i], false);
        }
      } else if (element.type === "relation") {
        if (element.center) give(element.id as number, element.center, true);
        const members = Array.isArray(element.members) ? (element.members as Raw[]) : [];
        const full = relations.get(element)?.full;
        for (const m of members) {
          if (m.type !== "node") continue;
          // A relation's node member is drawn as a point of its own.
          const facts = store.facts.get(m.ref as number);
          if (facts) facts.point = true;
          if (full && m.lat) give(m.ref as number, m, true);
        }
      }
    }
  }

  const push = (way: TableWay, at: number, key: Key | undefined, found: boolean, sure: boolean, held: boolean, lon: number, lat: number) => {
    store.way.push(way);
    store.at.push(at);
    store.key.push(key);
    store.found.push(found);
    store.sure.push(sure);
    store.held.push(held);
    store.lon.push(lon);
    store.lat.push(lat);
  };
  for (const way of read) {
    store.base.set(way, store.way.length);
    const ids = way.kind === "way" && Array.isArray(way.raw.nodes) ? (way.raw.nodes as number[]) : null;
    const geometry = ids ? [] : (way.raw.geometry as unknown[]);
    for (let i = 0; i < way.length; i++) {
      if (ids) {
        const facts = store.facts.get(ids[i])!;
        push(way, i, ids[i], facts.count > 0, facts.sure, facts.point || facts.ways.size > 1, facts.lon, facts.lat);
        continue;
      }
      const entry = geometry[i];
      if (!entry) {
        // A way named by coordinates names an empty entry by an unknown
        // place; a member's empty entry names nothing.
        if (way.kind === "way" && entry !== null) return null;
        push(way, i, way.kind === "way" ? UNKNOWN_LOCATION : undefined, false, true, false, NaN, NaN);
        continue;
      }
      const pair = readPair(entry);
      if (!pair) return null;
      push(way, i, `${ANONYMOUS}${pair.lat}/${pair.lon}`, true, true, false, pair.lon, pair.lat);
    }
  }
  return store;
}

function recognition(model: AssemblerModel): Recognition {
  const known: Recognition = { simple: new Map(), lines: new Map(), areas: new Map() };
  const add = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const feature of model.features) {
    const empty = !feature.tags || Object.keys(feature.tags).length === 0;
    if (feature.simple && feature.carrier) add(known.simple, feature.carrier);
    if (empty && feature.simple) add(known.areas, feature.shownId);
    if (empty && (feature.kind === "way" || feature.kind === "member")) add(known.lines, feature.shownId);
  }
  return known;
}

/** Whether the preview can tell the feature apart when it comes back: by
 * the mark on the tags it carries, or by its shape and id when the
 * assembler gives it empty tags of its own. */
function recognisable(feature: ModelFeature, store: NodeStore, known: Recognition): boolean {
  if (feature.carrier) {
    if (feature.simple && known.simple.get(feature.carrier) !== 1) return false;
    // A centre that shares its id with another node has its tags merged
    // with that node's.
    return !feature.carrier.center || store.facts.get(feature.carrier.id as number)?.count === 1;
  }
  return (feature.kind === "area" ? known.areas : known.lines).get(feature.shownId) === 1;
}

/** The positions of a way the assembler finds a node at, as vertices. */
function foundVertices(store: NodeStore, way: TableWay): number[] {
  const base = store.base.get(way)!;
  const vertices: number[] = [];
  for (let i = 0; i < way.length; i++) if (store.found[base + i]) vertices.push(base + i);
  return vertices;
}

const pairOf = (store: NodeStore, v: number) => pairBytes(store.lon[v], store.lat[v]);
const runBytes = (store: NodeStore, run: number[]) => run.reduce((sum, v) => sum + pairOf(store, v), 2 + Math.max(0, run.length - 1));
const listBytes = (parts: number[]) => parts.reduce((sum, n) => sum + n, 2 + Math.max(0, parts.length - 1));

/** Whether a point lies inside a ring by the crossing rule the assembler
 * applies to inner rings, with latitude as x and longitude as y. */
function inRing(store: NodeStore, x: number, y: number, ring: number[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = store.lat[ring[i]], yi = store.lon[ring[i]];
    const xj = store.lat[ring[j]], yj = store.lon[ring[j]];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The outer ring an inner ring joins: the first that holds any of its
 * nodes. */
function outerOf(store: NodeStore, inner: number[], outers: number[][]): number | undefined {
  for (let o = 0; o < outers.length; o++) {
    for (const v of inner) if (inRing(store, store.lat[v], store.lon[v], outers[o])) return o;
  }
  return undefined;
}

/** The feature's size apart from its geometry. */
function frameBytes(feature: ModelFeature, promoted: string[]): number {
  const built: BuiltFeature = { id: feature.id, properties: { type: feature.type, tags: feature.tags } };
  return jsonBytes({ type: "Feature", properties: propertiesWithoutTags(built, promoted), geometry: null }) - "null".length
    + textInStringBytes(feature.tags ?? {});
}

/** Whether the assembler draws a closed way carrying these tags as a
 * polygon, asked of the assembler itself on a ring of three nodes. */
function drawnAsPolygon(tags: Raw | undefined): boolean {
  if (tags === undefined) return false;
  let polygon = false;
  const probe = {
    elements: [
      { type: "node", id: 1, lat: 0, lon: 0 },
      { type: "node", id: 2, lat: 0, lon: 1 },
      { type: "node", id: 3, lat: 1, lon: 1 },
      { type: "way", id: 1, nodes: [1, 2, 3, 1], tags },
    ],
  };
  osmtogeojson(probe, { flatProperties: false }, (feature) => {
    if (feature.properties?.type === "way") polygon = feature.geometry?.type === "Polygon";
  });
  return polygon;
}

function standInFor(
  feature: ModelFeature, store: NodeStore, known: Recognition, promoted: string[], within: WithinShape | null, room: number,
): StandIn | null {
  const outside = (v: number) => !!within && !pointWithin(store.lon[v], store.lat[v], within);
  const keeps = new Map<TableWay, Set<number>>();
  const keep = (v: number) => {
    const way = store.way[v];
    let set = keeps.get(way);
    if (!set) keeps.set(way, set = new Set());
    set.add(store.at[v]);
  };
  let geometry: number;

  if (feature.kind === "way" || feature.kind === "member") {
    const way = feature.way!;
    const base = store.base.get(way)!;
    const last = base + way.length - 1;
    const vertices = foundVertices(store, way);
    // A way of fewer than two nodes makes no feature.
    if (vertices.length < 2 || vertices.some((v) => !store.sure[v])) return null;
    const coordinates = runBytes(store, vertices);
    // A member's way carries no tags, so it is drawn as a line.
    const closed = feature.kind === "way" && store.found[base] && store.found[last] && store.key[base] === store.key[last];
    geometry = closed && drawnAsPolygon(feature.tags)
      ? geometryFrame("Polygon") + coordinates + 2
      : geometryFrame("LineString") + coordinates;
    if (feature.kind === "way") { keep(base); keep(last); }
    keep(vertices[0]);
    keep(vertices[1]);
    const away = vertices.find(outside);
    if (away !== undefined) keep(away);
  } else {
    const lists = feature.members.map((m) => ({ role: m.role, vertices: foundVertices(store, m.way) }));
    if (lists.some((l) => l.vertices.some((v) => !store.sure[v]))) return null;
    const key = (v: number) => store.key[v] as Key;
    if (feature.kind === "route") {
      if (lists.length === 0) return null;
      const runs = joinRuns(lists.map((l) => l.vertices), key);
      geometry = runs.length === 1
        ? geometryFrame("LineString") + runBytes(store, runs[0])
        : geometryFrame("MultiLineString") + listBytes(runs.map((r) => runBytes(store, r)));
      const away = lists.flatMap((l) => l.vertices).find(outside);
      if (away !== undefined) keep(away);
    } else {
      const outerLists = lists.filter((l) => l.role === "outer").map((l) => l.vertices);
      const innerLists = lists.filter((l) => l.role === "inner").map((l) => l.vertices);
      const outers = joinRuns(outerLists, key);
      const inners = joinRuns(innerLists, key);
      const clusters = outers.map((ring) => [ring]);
      for (const inner of inners) {
        const o = outerOf(store, inner, outers);
        if (o !== undefined) clusters[o].push(inner);
      }
      const drawn = clusters.map((rings) => rings.filter((r) => r.length >= KEPT_RING)).filter((rings) => rings.length > 0);
      if (drawn.length === 0) return null;
      const clusterBytes = (rings: number[][]) => listBytes(rings.map((r) => runBytes(store, r)));
      geometry = drawn.length === 1
        ? geometryFrame("Polygon") + clusterBytes(drawn[0])
        : geometryFrame("MultiPolygon") + listBytes(drawn.map(clusterBytes));
      // A stand-in is possible only where the outer rings settle the
      // feature: one is kept, and either no area applies, or a kept outer
      // ring leaves it, or every inner node lies inside it as well.
      const keptOuters = outers.filter((r) => r.length >= KEPT_RING);
      if (keptOuters.length === 0) return null;
      const away = keptOuters.flat().find(outside);
      if (within && away === undefined && innerLists.flat().some(outside)) return null;
      if (away !== undefined) keep(away);
      for (const list of outerLists) {
        for (const v of [list[0], list[1], list[2], list[list.length - 1]]) if (v !== undefined) keep(v);
      }
    }
  }

  const bytes = frameBytes(feature, promoted) + geometry;
  if (bytes <= room || !recognisable(feature, store, known)) return null;
  return { feature, bytes, keeps };
}

/** A copy of an element's tags that carries the size of its feature. */
function marked(tags: unknown, bytes: number): Raw {
  const copy: Raw = { ...(tags as Raw | undefined) };
  Object.defineProperty(copy, MARK, { value: bytes, enumerable: false });
  return copy;
}

function standInPlan(response: unknown, model: AssemblerModel, store: NodeStore, proposed: StandIn[]): PreviewPlan {
  // A way read only by stood-in features is reduced in place, and so is a
  // way whose own line is stood in for: a relation not stood in for that
  // reads it reads a whole copy instead. A relation stood in for that
  // reads a way something else also reads gets its own reduced copy; the
  // way itself is then no longer marked skipped by that relation, so a
  // relation whose way would lose its only such mark is assembled whole,
  // which may leave further ways to copy.
  let standIns = proposed;
  let stood = new Set<ModelFeature>();
  const ownLine = new Map<TableWay, ModelFeature>();
  for (const feature of model.features) if (feature.kind === "way") ownLine.set(feature.way!, feature);
  const reducible = (way: TableWay) =>
    way.users.every((user) => stood.has(user)) || (way.kind === "way" && stood.has(ownLine.get(way)!));
  // Whether the relation that gives a member's way to others reads it
  // through a copy, and so gives it no longer.
  const giver = (way: TableWay) =>
    standIns.find(({ feature }) => feature.relation === way.relation && feature.members.some((m) => m.way === way && m.index === way.member));
  for (;;) {
    stood = new Set(standIns.map((s) => s.feature));
    const marking = new Set<TableRelation>();
    for (const { feature } of standIns) if (feature.relation) marking.add(feature.relation);
    const settled = (way: TableWay) => {
      if (reducible(way)) return true;
      // The way stays skipped by a relation that still reads it.
      if (way.skipped && !way.markers.some((relation) => !marking.has(relation))) return false;
      // A member's way that draws a line of its own is given on by the
      // area that gave it, which no longer reads it.
      return way.kind !== "member" || way.skipped || giver(way)?.feature.kind !== "route";
    };
    const next = standIns.filter(({ feature }) => feature.members.every((m) => settled(m.way)));
    if (next.length === standIns.length) break;
    standIns = next;
  }
  if (standIns.length === 0) return { response, sized: () => null, added: () => false };

  const replaced = new Map<Raw, Raw>();
  const replace = (raw: Raw): Raw => {
    let copy = replaced.get(raw);
    if (!copy) replaced.set(raw, copy = { ...raw });
    return copy;
  };
  // Each relation's members, place by place; a place may hold two.
  const slots = new Map<TableRelation, Raw[][]>();
  const slotsOf = (relation: TableRelation): Raw[][] => {
    let list = slots.get(relation);
    if (!list) slots.set(relation, list = (relation.members ?? []).map((m) => [m]));
    return list;
  };
  const copyAt = (way: TableWay, i: number) => {
    const v = store.base.get(way)! + i;
    return i < way.length && store.found[v] ? { lat: store.lat[v], lon: store.lon[v] } : null;
  };
  const entries = (way: TableWay, set: Set<number>, length = way.length) =>
    Array.from({ length }, (_, i) => (set.has(i) ? copyAt(way, i) : null));

  // Ids no element of the response uses, for the copies.
  const relationKeys = new Set(model.relations.map((relation) => relation.key));
  let unused = 0;
  const fresh = (taken: (id: number) => boolean) => {
    do unused--; while (taken(unused));
    return unused;
  };
  const wayTaken = (id: number) => model.table.has(String(id)) || model.table.has(FULL_GEOMETRY + id);
  const relationTaken = (id: number) => relationKeys.has(String(id));

  const appended: Raw[] = [];
  // A copy no relation marks as skipped draws a line of its own.
  const drawn = new Set<number>();

  // The positions each way reduced in place keeps.
  const kept = new Map<TableWay, Set<number>>();
  for (const [way, base] of store.base) {
    if (!reducible(way)) continue;
    const set = new Set<number>();
    for (const { keeps } of standIns) for (const at of keeps.get(way) ?? []) set.add(at);
    for (let i = 0; i < way.length; i++) if (store.held[base + i]) set.add(i);
    kept.set(way, set);
  }
  for (const [way, set] of kept) {
    if (way.kind === "member") {
      slotsOf(way.relation!)[way.member!] = [{ ...way.raw, geometry: entries(way, set) }];
    } else {
      const positions = [...set].sort((a, b) => a - b);
      const element = replace(way.raw);
      if (Array.isArray(way.raw.nodes)) element.nodes = positions.map((i) => (way.raw.nodes as number[])[i]);
      if (Array.isArray(way.raw.geometry)) {
        const geometry = way.raw.geometry as unknown[];
        element.geometry = positions.map((i) => (geometry[i] ? copyAt(way, i) : geometry[i]));
      }
    }
  }

  // A relation not stood in for reads a whole copy of a way reduced in
  // place: the same nodes, given the same way, without tags, after
  // everything the assembler would draw. Being without tags, the copy is
  // marked skipped by the relation that reads it, or draws a line of its
  // own that the preview leaves out; the way itself, which has a line of
  // its own, was marked by no relation.
  const whole = new Set<TableWay>();
  for (const way of kept.keys()) {
    const readers = way.users.filter((user) => !stood.has(user));
    if (readers.length === 0) continue;
    const id = fresh(wayTaken);
    const copy: Raw = { type: "way", id };
    if (way.raw.nodes !== undefined) copy.nodes = way.raw.nodes;
    if (way.raw.geometry !== undefined) copy.geometry = way.raw.geometry;
    appended.push(copy);
    drawn.add(id);
    whole.add(way);
    for (const reader of readers) {
      for (const { way: read, index } of reader.members) {
        if (read === way) slotsOf(reader.relation!)[index] = [{ ...reader.relation!.members![index], ref: id }];
      }
    }
  }

  // A node no way names any longer would be drawn as a point of its own:
  // the node elements that give it go too.
  const removed = new Set<Raw>();
  for (const [id, facts] of store.facts) {
    if (facts.point || facts.nodes.length === 0) continue;
    const named = [...facts.ways].some((way) => {
      const set = kept.get(way);
      return !set || whole.has(way) || (way.raw.nodes as number[]).some((n, i) => n === id && set.has(i));
    });
    if (!named) for (const node of facts.nodes) removed.add(node);
  }

  // The reduced copies, for every way a stood-in relation reads that is
  // not reduced in place. A copy of a way element comes last, after
  // everything the assembler would draw; a copy of a member's way is the
  // member's own. Where the relation that gives a member's way to others
  // reads it through a copy, the way is still given: by a relation of its
  // own just ahead, with no tags and so drawing nothing, when the way is
  // skipped and its place among the ways does not matter; otherwise by
  // the area itself, under a role its rings do not read.
  const before = new Map<Raw, Raw[]>();
  const given = new Set<TableWay>();
  const carriers = new Map<StandIn, Raw>();
  const areaIds = new Map<StandIn, string>();
  for (const standIn of standIns) {
    const { feature, keeps } = standIn;
    const relation = feature.relation;
    if (!relation) continue;
    const copies = new Map<TableWay, number>();
    for (const { way, index } of feature.members) {
      if (reducible(way)) continue;
      const set = keeps.get(way) ?? new Set<number>();
      let id = copies.get(way);
      if (id === undefined) {
        id = fresh(wayTaken);
        copies.set(way, id);
        if (way.kind === "way") {
          const copy: Raw = { type: "way", id };
          const positions = [...set].sort((a, b) => a - b);
          if (Array.isArray(way.raw.nodes)) copy.nodes = positions.map((i) => (way.raw.nodes as number[])[i]);
          else copy.geometry = positions.map((i) => copyAt(way, i));
          appended.push(copy);
          if (feature.simple && way === feature.outer) carriers.set(standIn, copy);
          else drawn.add(id);
        } else {
          if (!given.has(way) && way.skipped && giver(way)) {
            given.add(way);
            const giver = { type: "relation", id: fresh(relationTaken), members: [way.raw] };
            const list = before.get(way.relation!.raw);
            if (list) list.push(giver);
            else before.set(way.relation!.raw, [giver]);
          }
          if (feature.simple && way === feature.outer) areaIds.set(standIn, String(id));
          else drawn.add(id);
        }
      }
      const raw = relation.members![index];
      const copy = way.kind === "way"
        ? { ...raw, ref: id }
        : { ...raw, ref: id, geometry: entries(way, set, Math.max(way.length, (raw.geometry as unknown[]).length)) };
      slotsOf(relation)[index] = way.kind === "member" && !way.skipped && way.relation === relation && way.member === index
        ? [{ ...raw, role: GIVEN }, copy]
        : [copy];
    }
  }
  for (const [relation, list] of slots) replace(relation.raw).members = list.flat();

  const lines = new Map<string, number>();
  const areas = new Map<string, number>();
  for (const standIn of standIns) {
    const { feature, bytes } = standIn;
    const carrier = carriers.get(standIn);
    if (carrier) carrier.tags = marked(feature.carrier!.tags, bytes);
    else if (feature.carrier) replace(feature.carrier).tags = marked(feature.carrier.tags, bytes);
    else if (feature.kind === "area") areas.set(areaIds.get(standIn) ?? feature.shownId, bytes);
    else lines.set(feature.shownId, bytes);
  }

  const elements: Raw[] = [];
  for (const element of model.elements) {
    if (removed.has(element)) continue;
    for (const giver of before.get(element) ?? []) elements.push(giver);
    elements.push(replaced.get(element) ?? element);
  }
  for (const copy of appended) elements.push(copy);
  return {
    response: { ...(response as Raw), elements },
    sized(feature) {
      const props = feature.properties;
      // A centre or the bounds of an element carry its tags too.
      if (!props || props.geometry !== undefined) return null;
      const tags = props.tags;
      if (!tags || typeof tags !== "object") return null;
      const size = (tags as { [MARK]?: number })[MARK];
      if (size !== undefined) return size;
      if (props.type !== "way" || Object.keys(tags).length) return null;
      const type = feature.geometry?.type;
      if (type === "LineString") return lines.get(String(props.id)) ?? null;
      if (type === "Polygon" || type === "MultiPolygon") return areas.get(String(props.id)) ?? null;
      return null;
    },
    added(feature) {
      const props = feature.properties;
      return props?.type === "way" && drawn.has(props.id as number);
    },
  };
}
