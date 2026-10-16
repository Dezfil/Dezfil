import { joinRuns, KEPT_RING } from "./assembler-rings";
import { pointWithin, type WithinShape } from "./geometry";

/**
 * Whether an Overpass response holds one element too large for a preview
 * on its own, that the preview would certainly carry, decided from the raw
 * elements before the assembler builds any of them. The assembler builds a
 * feature whole before it hands it over, every coordinate and the tags
 * serialized, so a single element over Bytes drawn per layer would be
 * built whole only to be refused.
 *
 * Each element's size has a lower bound read without building anything:
 * every coordinate pair at least `[0,0]` with its comma, and the tags'
 * keys and string values each within their quotes. An element whose bound
 * exceeds what an answer has room for refuses the preview when the answer
 * certainly carries it: the cap cannot leave it out, which holds when the
 * response cannot yield more features than the cap, the assembler
 * certainly makes a feature of it with every coordinate counted, and it
 * lies inside the area the preview is limited to. Where any of that is
 * uncertain (a feature the cap or a later line may push out, an element the
 * assembler may fold into another), the element is assembled and the
 * answer decided as before. A multipolygon counts only the outer rings the
 * assembler keeps, and one that keeps none makes no feature to count.
 */
export function certainlyTooLarge(response: unknown, within: WithinShape | null, cap: number, room: number): boolean {
  const elements = elementsOf(response);
  const oversized = elements.filter((element) => lowerBound(element) > room);
  if (oversized.length === 0 || featuresAtMost(elements) > cap) return false;
  const facts = responseFacts(elements);
  return oversized.some((element) => assembledWhole(element, facts) && (!within || inside(element, within)));
}

interface Element {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  tags?: unknown;
  nodes?: unknown;
  geometry?: unknown;
  members?: unknown;
  center?: unknown;
  bounds?: unknown;
}

interface Member {
  type?: unknown;
  ref?: unknown;
  role?: unknown;
  geometry?: unknown;
  lat?: unknown;
}

function elementsOf(response: unknown): Element[] {
  const elements = (response as { elements?: unknown } | null)?.elements;
  return Array.isArray(elements) ? elements.filter((e): e is Element => !!e && typeof e === "object") : [];
}

function membersOf(element: Element): Member[] {
  return Array.isArray(element.members) ? element.members.filter((m): m is Member => !!m && typeof m === "object") : [];
}

/** The coordinates a raw geometry holds: the assembler drops the empty
 * entries an out-of-range node leaves. */
function vertices(geometry: unknown): number {
  if (!Array.isArray(geometry)) return 0;
  let count = 0;
  for (const vertex of geometry) if (vertex) count++;
  return count;
}

/** At least `[0,0]` per pair, with a comma between pairs. */
function coordinateBytes(pairs: number): number {
  return pairs > 0 ? 6 * pairs - 1 : 0;
}

/** The tags travel as one JSON text inside a string: at least braces, each
 * key and string value within quotes, a colon and the commas. */
function tagBytes(tags: unknown): number {
  if (!tags || typeof tags !== "object") return 0;
  let bytes = 2, count = 0;
  for (const [key, value] of Object.entries(tags)) {
    bytes += (count++ ? 1 : 0) + key.length + 2 + 1 + (typeof value === "string" ? value.length + 2 : 1);
  }
  return bytes;
}

const relationType = (element: Element): unknown => (element.tags as { type?: unknown } | null | undefined)?.type;
const wayMembers = (element: Element) => membersOf(element).filter((m) => m.type === "way");
/** The members a multipolygon assembles into its outer rings. */
const outerMembers = (element: Element) => wayMembers(element).filter((m) => m.role === "outer" || !m.role);

/** The outer rings a multipolygon's own member geometry joins into, by
 * node count: members with the role outer or none, their empty entries
 * dropped as the assembler drops them. Nodes are named by their
 * coordinates, as the assembler names the nodes of member geometry. */
function outerRings(element: Element): number[] {
  const names = new Map<object, string>();
  const name = (vertex: Element) => {
    let known = names.get(vertex);
    if (known === undefined) names.set(vertex, known = `${vertex.lat}/${vertex.lon}`);
    return known;
  };
  const ways = outerMembers(element).map((m) => (Array.isArray(m.geometry) ? m.geometry : []).filter((v): v is Element => !!v));
  return joinRuns(ways, name).map((run) => run.length);
}

/** The node count of the outer rings the assembler keeps. */
const keptOuterNodes = (element: Element) =>
  outerRings(element).filter((n) => n >= KEPT_RING).reduce((sum, n) => sum + n, 0);

function lowerBound(element: Element): number {
  switch (element.type) {
    case "node":
      return coordinateBytes(1) + tagBytes(element.tags);
    case "way":
      return coordinateBytes(vertices(element.geometry)) + tagBytes(element.tags);
    case "relation": {
      const type = relationType(element);
      if (type === "route" || type === "waterway") {
        // Joining two members drops the node they share.
        const members = wayMembers(element).map((m) => vertices(m.geometry)).filter((n) => n > 0);
        const pairs = members.reduce((sum, n) => sum + n, 0) - Math.max(0, members.length - 1);
        return coordinateBytes(Math.max(0, pairs)) + tagBytes(element.tags);
      }
      if (type === "multipolygon" || type === "boundary") {
        // Only the outer rings the assembler keeps are certain to be drawn.
        // With a single outer ring the feature may take the ring's tags
        // instead of the relation's.
        const named = membersOf(element).filter((m) => m.type === "way" && m.role === "outer").length >= 2;
        return coordinateBytes(keptOuterNodes(element)) + (named ? tagBytes(element.tags) : 0);
      }
      return 0;
    }
    default:
      return 0;
  }
}

/** The most features the assembler can make of the response: a node or
 * way one, each centre one more, a relation one, its bounds one more and
 * each of its members one more. */
function featuresAtMost(elements: Element[]): number {
  let count = 0;
  for (const element of elements) {
    if (element.type === "node") count += 1;
    else if (element.type === "way") count += 1 + (element.center ? 1 : 0);
    else if (element.type === "relation") count += 1 + (element.center ? 1 : 0) + (element.bounds ? 1 : 0) + membersOf(element).length;
  }
  return count;
}

interface Facts {
  /** How often each id names a node: a way's or relation's centre and a
   * relation's located node members among them. */
  points: Map<unknown, number>;
  /** How often each id names a way, a relation's bounds among them. */
  ways: Map<unknown, number>;
  relations: Map<unknown, number>;
  /** The ways some relation names as a member. */
  memberWays: Set<unknown>;
  /** The relation whose member geometry the assembler reads for each
   * member way: the first that carries it. */
  definers: Map<string, Element>;
}

function responseFacts(elements: Element[]): Facts {
  const facts: Facts = { points: new Map(), ways: new Map(), relations: new Map(), memberWays: new Set(), definers: new Map() };
  const count = (map: Map<unknown, number>, id: unknown) => map.set(id, (map.get(id) ?? 0) + 1);
  for (const element of elements) {
    if (element.type === "node") count(facts.points, element.id);
    if (element.type === "way") count(facts.ways, element.id);
    if (element.type === "relation") {
      count(facts.relations, element.id);
      if (element.bounds) count(facts.ways, element.id);
      for (const member of wayMembers(element)) {
        facts.memberWays.add(member.ref);
        const defined = `${member.ref}`;
        if (member.geometry && !facts.definers.has(defined)) facts.definers.set(defined, element);
      }
    }
    if ((element.type === "way" || element.type === "relation") && element.center) count(facts.points, element.id);
    // A relation's located node members are read as nodes of their own.
    for (const member of membersOf(element)) if (member.type === "node" && member.lat !== undefined) count(facts.points, member.ref);
  }
  return facts;
}

/** The assembler's own rule for a node: a tag other than these makes it a
 * feature whatever references it. */
function describes(key: string): boolean {
  switch (key) {
    case "source":
    case "source_ref":
    case "source:ref":
    case "history":
    case "attribution":
    case "created_by":
    case "tiger:county":
    case "tiger:tlid":
    case "tiger:upload_uuid":
      return false;
    default:
      return true;
  }
}

/** Whether the assembler certainly makes a feature of the element alone,
 * with every coordinate its bound counts. */
function assembledWhole(element: Element, facts: Facts): boolean {
  switch (element.type) {
    case "node":
      return element.lat !== undefined && element.lon !== undefined && facts.points.get(element.id) === 1
        && !!element.tags && typeof element.tags === "object" && Object.keys(element.tags).some(describes);
    case "way": {
      const geometry = element.geometry;
      return Array.isArray(geometry) && vertices(geometry) >= 2
        && (element.nodes === undefined || (Array.isArray(element.nodes) && element.nodes.length === geometry.length))
        && facts.ways.get(element.id) === 1 && !facts.memberWays.has(element.id);
    }
    case "relation": {
      if (facts.relations.get(element.id) !== 1) return false;
      const type = relationType(element);
      if (type === "route" || type === "waterway") return wayMembers(element).some((m) => vertices(m.geometry) > 0);
      if (type === "multipolygon" || type === "boundary") {
        // Every outer ring is read from this relation's own member
        // geometry, and at least one of them is kept.
        const outer = membersOf(element).filter((m) => m.type === "way" && m.role === "outer");
        return outer.length > 0 && outer.every((m) => Array.isArray(m.geometry) && m.geometry.length > 0)
          && outerMembers(element).every((m) => Array.isArray(m.geometry) && facts.definers.get(`${m.ref}`) === element)
          && keptOuterNodes(element) > 0;
      }
      return false;
    }
    default:
      return false;
  }
}

function verticesInside(geometry: unknown, shape: WithinShape): boolean {
  if (!Array.isArray(geometry)) return false;
  for (const vertex of geometry) {
    if (vertex && !pointWithin(+(vertex as Element).lon!, +(vertex as Element).lat!, shape)) return false;
  }
  return true;
}

/** Whether every coordinate the feature can hold lies in the shape. */
function inside(element: Element, shape: WithinShape): boolean {
  switch (element.type) {
    case "node":
      return pointWithin(+element.lon!, +element.lat!, shape);
    case "way":
      // A node left out of the geometry may still be found by its id.
      return Array.isArray(element.geometry) && (element.nodes === undefined || element.geometry.every(Boolean))
        && verticesInside(element.geometry, shape);
    case "relation":
      return wayMembers(element).every((m) => verticesInside(m.geometry, shape));
    default:
      return false;
  }
}
