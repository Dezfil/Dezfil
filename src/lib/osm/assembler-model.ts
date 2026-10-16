/*
 * The rules read here are osmtogeojson 3.0.0-beta.5's (index.js), and the
 * tags it treats as saying nothing of an element are its default list.
 * Its notice follows.
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
 */

/**
 * The structure the OpenStreetMap assembler gives an Overpass response,
 * read from the raw elements without assembling anything: its way table,
 * the ways it skips, and the features it can build and from which ways.
 * Coordinates are not read here.
 *
 * The assembler keeps one way table, in element order: each way element;
 * for a relation with member geometry, one way per member way that
 * carries geometry, named by the member's reference, unless an earlier
 * relation already gave that member's way; and a way for the bounds of a
 * relation without member geometry. A relation's members are looked up in
 * that table by reference. Relations are processed in element order, and
 * a route, waterway, multipolygon or boundary relation marks member ways
 * whose tags say nothing of their own as skipped; the remaining ways are
 * then built in table order.
 *
 * Only responses of the shape Overpass writes are read: numeric ids and
 * references, string tags, roles and types, and no id that two elements
 * of one table share. For anything else the model is null, and the
 * response is assembled as it always was.
 */

export type Raw = Record<string, unknown>;

/** Names the assembler gives the ways it reads from member geometry. */
export const FULL_GEOMETRY = "_fullGeom";

/** A way in the assembler's way table. */
export interface TableWay {
  kind: "way" | "member" | "bounds";
  /** The way element, or the member whose geometry this way is. */
  raw: Raw;
  /** For a member way: the relation it is read from, and the member's
   * place among that relation's members. */
  relation?: TableRelation;
  member?: number;
  /** The way's name in the table. */
  key: string;
  /** The tags the way carries. */
  tags: Raw | undefined;
  /** Whether the assembler gives the way a node list, and its length. */
  listed: boolean;
  length: number;
  skipped: boolean;
  /** The relations whose processing marks the way as skipped. */
  markers: TableRelation[];
  /** The features that read this way's nodes for their geometry. */
  users: ModelFeature[];
}

export interface TableRelation {
  raw: Raw;
  key: string;
  members: Raw[] | null;
  /** Whether its member geometry is read. */
  full: boolean;
  /** Whether the table holds a way for its bounds, a feature that carries
   * the relation's tags too. */
  bounded: boolean;
}

export type MemberRole = "outer" | "inner" | "other";

/** A feature the assembler may build from ways. */
export interface ModelFeature {
  kind: "way" | "member" | "route" | "area";
  /** The way a way feature is built from. */
  way?: TableWay;
  relation?: TableRelation;
  /** The ways a relation's feature is built from, with their roles and
   * their places among the relation's members. */
  members: { way: TableWay; role: MemberRole; index: number }[];
  /** For an area: whether it takes its tags and name from its one outer
   * way, and that way. */
  simple: boolean;
  outer?: TableWay;
  /** The feature's id, its properties' type and its tags. */
  id: string;
  type: string;
  tags: Raw | undefined;
  /** The element whose tags object the feature carries, or null when the
   * assembler makes the feature an empty one. */
  carrier: Raw | null;
  /** The properties' id. */
  shownId: string;
}

export interface AssemblerModel {
  elements: Raw[];
  ways: TableWay[];
  relations: TableRelation[];
  features: ModelFeature[];
  /** The way table by name. */
  table: Map<string, TableWay>;
}

const UNINTERESTING = new Set([
  "source", "source_ref", "source:ref", "history", "attribution", "created_by",
  "tiger:county", "tiger:tlid", "tiger:upload_uuid",
]);

/** The assembler's test for tags that describe the element itself: any
 * name but the bookkeeping ones, and none that the given tags already
 * carry with the same value (or carry as true). */
export function interesting(tags: Raw | undefined, ignore: Raw = {}): boolean {
  if (!tags) return false;
  for (const name of Object.keys(tags)) {
    if (!UNINTERESTING.has(name) && !(ignore[name] === true || ignore[name] === tags[name])) return true;
  }
  return false;
}

const isString = (value: unknown) => typeof value === "string";
const isNumber = (value: unknown) => typeof value === "number";

/** String tags, or none. */
function plainTags(tags: unknown): tags is Raw | undefined {
  if (tags === undefined) return true;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return false;
  return Object.values(tags).every(isString);
}

/** Whether a member is shaped as Overpass writes members. */
function plainMember(member: unknown): member is Raw {
  if (!member || typeof member !== "object") return false;
  const m = member as Raw;
  return (m.type === undefined || isString(m.type)) && (m.role === undefined || m.role === null || isString(m.role))
    && (m.type !== "node" && m.type !== "way" || isNumber(m.ref))
    && (!m.geometry || Array.isArray(m.geometry));
}

export function readAssemblerModel(response: unknown): AssemblerModel | null {
  const elements = (response as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return null;
  const ways: TableWay[] = [];
  const relations: TableRelation[] = [];
  const table = new Map<string, TableWay>();
  const relationKeys = new Set<string>();
  const add = (way: TableWay): boolean => {
    if (table.has(way.key)) return false;
    table.set(way.key, way);
    ways.push(way);
    return true;
  };

  for (const element of elements as unknown[]) {
    if (!element || typeof element !== "object") return null;
    const raw = element as Raw;
    if (!plainTags(raw.tags)) return null;
    if (raw.type === "node") {
      if (!isNumber(raw.id)) return null;
    } else if (raw.type === "way") {
      if (!isNumber(raw.id)) return null;
      const nodes = raw.nodes;
      if (nodes !== undefined && !(Array.isArray(nodes) && nodes.every(isNumber))) return null;
      const listed = Array.isArray(nodes);
      const geometry = raw.geometry;
      let length = listed ? (nodes as unknown[]).length : 0;
      if (geometry) {
        if (!Array.isArray(geometry) || (listed && geometry.length !== length)) return null;
        length = geometry.length;
      } else if (raw.bounds) {
        // Such a way shares its name with the way of its own bounds.
        return null;
      }
      if (!add({ kind: "way", raw, key: String(raw.id), tags: raw.tags, listed: listed || !!geometry, length, skipped: false, markers: [], users: [] })) return null;
    } else if (raw.type === "relation") {
      if (!isNumber(raw.id)) return null;
      const members = raw.members;
      if (members !== undefined && members !== null && !(Array.isArray(members) && members.every(plainMember))) return null;
      const list = Array.isArray(members) ? (members as Raw[]) : null;
      const full = !!list && list.some((m) => (m.type === "node" && !!m.lat)
        || (m.type === "way" && !!m.geometry && (m.geometry as unknown[]).length > 0));
      const relation: TableRelation = { raw, key: String(raw.id), members: list, full, bounded: !full && !!raw.bounds };
      if (relationKeys.has(relation.key)) return null;
      relationKeys.add(relation.key);
      relations.push(relation);
      if (full) {
        for (const [member, m] of list!.entries()) {
          if (m.type !== "way" || !m.geometry) continue;
          const key = FULL_GEOMETRY + m.ref;
          // A member way an earlier relation gave keeps that geometry.
          if (table.has(key)) continue;
          add({ kind: "member", raw: m, relation, member, key, tags: undefined, listed: true, length: (m.geometry as unknown[]).length, skipped: false, markers: [], users: [] });
        }
      } else if (raw.bounds) {
        if (!add({ kind: "bounds", raw, key: relation.key, tags: raw.tags as Raw | undefined, listed: true, length: 5, skipped: false, markers: [], users: [] })) return null;
      }
    }
  }

  const features: ModelFeature[] = [];
  const wayOf = (relation: TableRelation, member: Raw): TableWay | undefined =>
    table.get(relation.full && member.type === "way" && member.geometry ? FULL_GEOMETRY + member.ref : String(member.ref));
  const roleOf = (member: Raw): MemberRole => {
    const role = member.role || "outer";
    return role === "outer" || role === "inner" ? role : "other";
  };
  // An area reads only its outer and inner ways for its geometry.
  const membersOf = (relation: TableRelation, kind: "route" | "area") => relation.members!
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.type === "way" && (kind === "route" || roleOf(m) !== "other"))
    .map(({ m, index }) => ({ way: wayOf(relation, m), role: roleOf(m), index }))
    .filter((m): m is { way: TableWay; role: MemberRole; index: number } => !!m.way && m.way.listed);
  const mark = (way: TableWay, relation: TableRelation) => {
    way.skipped = true;
    way.markers.push(relation);
  };
  const relationFeature = (relation: TableRelation, kind: "route" | "area"): ModelFeature => ({
    kind, relation, members: membersOf(relation, kind), simple: false,
    id: `relation/${relation.raw.id}`, type: "relation", tags: relation.raw.tags as Raw, carrier: relation.raw, shownId: relation.key,
  });

  for (const relation of relations) {
    const tags = relation.raw.tags as Raw | undefined;
    if (tags === undefined) continue;
    const members = relation.members;
    if (tags.type === "route" || tags.type === "waterway") {
      if (!members) continue;
      for (const m of members) {
        const way = wayOf(relation, m);
        if (way && !interesting(way.tags)) mark(way, relation);
      }
      features.push(relationFeature(relation, "route"));
    }
    if (tags.type === "multipolygon" || tags.type === "boundary") {
      if (!members) continue;
      for (const m of members) {
        const way = wayOf(relation, m);
        if (!way) continue;
        if (m.role === "outer" && !interesting(way.tags, tags)) mark(way, relation);
        if (m.role === "inner" && !interesting(way.tags)) mark(way, relation);
      }
      const outers = members.filter((m) => m.role === "outer");
      if (outers.length === 0) continue;
      if (outers.length === 1 && !interesting(tags, { type: true })) {
        // The area takes the tags and the name of its one outer way.
        const outer = wayOf(relation, outers[0]);
        if (!outer) continue;
        mark(outer, relation);
        const shown = outer.kind === "member" ? String(+String(outer.raw.ref)) : outer.key;
        features.push({
          ...relationFeature(relation, "area"), simple: true, outer,
          id: `way/${shown}`, type: "way", tags: outer.tags, carrier: outer.kind === "member" ? null : outer.raw, shownId: shown,
        });
      } else {
        features.push(relationFeature(relation, "area"));
      }
    }
  }
  for (const way of ways) {
    if (!way.listed || way.skipped || way.kind === "bounds") continue;
    const shown = way.kind === "member" ? String(+String(way.raw.ref)) : way.key;
    features.push({
      kind: way.kind === "member" ? "member" : "way", way, members: [], simple: false,
      id: `way/${shown}`, type: "way", tags: way.tags, carrier: way.kind === "member" ? null : way.raw, shownId: shown,
    });
  }
  for (const feature of features) {
    if (feature.way) feature.way.users.push(feature);
    for (const { way } of feature.members) if (!way.users.includes(feature)) way.users.push(feature);
  }
  return { elements: elements as Raw[], ways, relations, features, table };
}
