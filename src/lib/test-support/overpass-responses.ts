/**
 * Overpass responses of the shapes Overpass writes, generated from a seed:
 * points, tagged nodes on ways, ways that share their nodes, given with
 * their geometry or by node elements that follow them, closed rings,
 * routes and multipolygons whose members carry their own geometry or name
 * ways of the response, simple multipolygons, and tags that need escaping.
 * Some elements are long enough to pass a small byte limit on their own.
 */

type Element = Record<string, unknown>;
type Point = [number, number];

export interface OverpassResponse {
  version: number;
  elements: Element[];
}

const TEXTS = ['Alpha "Ä"', "back\\slash", "tab\tline\nbreak", "\u0001\u001f", "é ü ß", "東京", "😀 emoji", "\ud800 lone", "plain"];

export function overpassResponse(seed: number): OverpassResponse {
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(items: T[]): T => items[int(items.length)];
  const chance = (p: number) => random() < p;
  const precise = (v: number) => Math.round(v * 1e7) / 1e7;
  const text = (long: boolean) => (long ? pick(TEXTS).repeat(40 + int(300)) : pick(TEXTS));

  const positions = new Map<number, Point>();
  let nextNode = chance(0.5) ? 5_000_000_000 : 1000;
  let nextWay = 100;
  let nextRelation = 1;
  const nodeAt = (at: Point): number => {
    const id = nextNode++;
    positions.set(id, [precise(at[0]), precise(at[1])]);
    return id;
  };
  const start = (): Point => [13.3 + random() * 0.2, 52.4 + random() * 0.2];
  /** Node ids along a walk, beginning at a given node or a new one. */
  const walk = (length: number, from?: number): number[] => {
    let at: Point = from !== undefined ? positions.get(from)! : start();
    const ids = [from ?? nodeAt(at)];
    const step = 0.0002 + random() * 0.002;
    for (let i = 1; i < length; i++) {
      at = [at[0] + (random() - 0.4) * step, at[1] + (random() - 0.5) * step];
      ids.push(nodeAt(at));
    }
    return ids;
  };
  const ring = (length: number, size = 0.002 + random() * 0.02, centre = start()): number[] => {
    const ids: number[] = [];
    for (let i = 0; i < length; i++) {
      const angle = (2 * Math.PI * i) / length;
      ids.push(nodeAt([centre[0] + size * Math.cos(angle), centre[1] + size * 0.6 * Math.sin(angle)]));
    }
    return [...ids, ids[0]];
  };
  const geometryOf = (ids: number[]) => ids.map((id) => ({ lat: positions.get(id)![1], lon: positions.get(id)![0] }));
  const length = () => (chance(0.2) ? 300 + int(1500) : 2 + int(12));

  const pois: Element[] = [];
  const ways: Element[] = [];
  const relations: Element[] = [];
  const skeleton = new Set<number>();
  const tagged = new Map<number, Record<string, string>>();
  const allWays: { id: number; ids: number[] }[] = [];

  for (let i = 0, n = 2 + int(6); i < n; i++) {
    const id = nodeAt(start());
    const tags: Record<string, string> = { amenity: pick(["bench", "cafe", "fountain"]) };
    if (chance(0.7)) tags.name = text(chance(0.15));
    pois.push({ type: "node", id, lat: positions.get(id)![1], lon: positions.get(id)![0], tags });
  }

  const addWay = (ids: number[], tags: Record<string, string> | undefined) => {
    const id = nextWay++;
    const style = pick(["geom", "geom", "body"]);
    const element: Element = { type: "way", id, nodes: ids };
    if (style === "geom") element.geometry = geometryOf(ids);
    else for (const node of ids) skeleton.add(node);
    if (tags) element.tags = tags;
    ways.push(element);
    allWays.push({ id, ids });
    return id;
  };

  for (let i = 0, n = 3 + int(8); i < n; i++) {
    const shared = allWays.length && chance(0.5) ? pick(pick(allWays).ids) : undefined;
    const ids = walk(length(), shared);
    if (allWays.length && chance(0.3)) ids.push(pick(pick(allWays).ids));
    const tags: Record<string, string> = { highway: pick(["residential", "path", "service"]) };
    if (chance(0.6)) tags.name = text(chance(0.15));
    if (chance(0.2)) {
      // A crossing: a tagged node on the way.
      const node = pick(ids);
      tagged.set(node, { highway: "crossing" });
    }
    addWay(ids, tags);
  }
  for (let i = 0, n = 1 + int(4); i < n; i++) {
    const ids = ring(chance(0.2) ? 300 + int(1200) : 4 + int(10));
    // A closed way is a polygon by its tags, or a closed line.
    addWay(ids, chance(0.7) ? { building: "yes", name: text(chance(0.2)) } : { highway: "pedestrian", area: "no" });
  }

  const member = (id: number, ids: number[], role: string, geometry: boolean): Element =>
    geometry ? { type: "way", ref: id, role, geometry: geometryOf(ids) } : { type: "way", ref: id, role };

  for (let i = 0, n = int(3); i < n && allWays.length; i++) {
    // A route over ways of the response, carrying their geometry or not.
    const full = chance(0.7);
    const members = Array.from({ length: 1 + int(4) }, () => {
      const way = pick(allWays);
      return member(way.id, way.ids, pick(["", "forward", "backward"]), full);
    });
    if (full && chance(0.4)) {
      // A member way the response does not carry.
      const ids = walk(length());
      members.push(member(nextWay++, ids, "", true));
    }
    relations.push({ type: "relation", id: nextRelation++, members, tags: { type: "route", route: "bus", name: text(chance(0.3)) } });
  }
  for (let i = 0, n = int(3); i < n; i++) {
    // A multipolygon: an outer ring in two ways, an inner ring, a subarea.
    const size = 0.01 + random() * 0.03;
    const centre = start();
    const outer = ring(chance(0.3) ? 600 + int(1500) : 6 + int(20), size, centre);
    const half = Math.floor(outer.length / 2);
    const inner = ring(4 + int(8), size / 4, centre);
    const members: Element[] = [
      member(nextWay++, outer.slice(0, half + 1), "outer", true),
      member(nextWay++, outer.slice(half), chance(0.5) ? "outer" : "", true),
      member(nextWay++, inner, "inner", true),
    ];
    if (allWays.length && chance(0.5)) {
      const way = pick(allWays);
      members.push(member(way.id, way.ids, "subarea", true));
    }
    relations.push({ type: "relation", id: nextRelation++, members, tags: { type: "multipolygon", landuse: "forest", name: text(chance(0.3)) } });
  }
  if (chance(0.6)) {
    // A simple multipolygon whose one outer way carries no tags of its own.
    const ids = ring(chance(0.3) ? 400 + int(800) : 5 + int(10));
    relations.push({ type: "relation", id: nextRelation++, members: [member(nextWay++, ids, "outer", true)], tags: { type: "multipolygon" } });
  }
  if (chance(0.6)) {
    // A simple multipolygon whose outer way is an element of the response.
    const ids = ring(chance(0.3) ? 400 + int(800) : 5 + int(10));
    const id = addWay(ids, { building: "yes", note: text(chance(0.3)) });
    relations.push({ type: "relation", id: nextRelation++, members: [{ type: "way", ref: id, role: "outer" }], tags: { type: "multipolygon" } });
  }
  if (chance(0.6)) {
    // A site whose member ways are drawn as lines of their own.
    const members = Array.from({ length: 1 + int(2) }, () => member(nextWay++, walk(length()), "", true));
    relations.push({ type: "relation", id: nextRelation++, members, tags: { type: "site", name: text(false) } });
  }

  const skeletonNodes: Element[] = [...skeleton].map((id) => {
    const [lon, lat] = positions.get(id)!;
    const node: Element = { type: "node", id, lat, lon };
    if (tagged.has(id)) node.tags = tagged.get(id);
    return node;
  });
  for (const [id, tags] of tagged) {
    if (skeleton.has(id)) continue;
    const [lon, lat] = positions.get(id)!;
    pois.push({ type: "node", id, lat, lon, tags });
  }
  return { version: 0.6, elements: [...pois, ...ways, ...relations, ...skeletonNodes] };
}
