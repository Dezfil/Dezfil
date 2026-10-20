// What a scene's page may ask for off the instance. The picture run takes
// every scene from the run alone: each request off the instance's own origin
// is refused and fails the run, naming its address. A scene that shows a map
// is the one exception: it may reach the built-in basemap, so its pictures
// show the map a reader sees, with its true credit. The built-in basemap is
// the styles the app lists (src/lib/basemap.ts) and every host those styles
// name for their tiles, glyphs and sprites. Every other host fails the run in
// a map scene too, and the basemap's own hosts fail it in a scene that shows
// no map. A basemap request that fails or answers with an error fails the
// run as well, so a picture never shows a map whose basemap did not load.
import { BASEMAPS } from "../src/lib/basemap.ts";

/**
 * The hosts the built-in styles name for their content: the vector tiles
 * (through the source's tile description), the shaded-relief raster tiles,
 * the glyphs and the sprites. Read from the three styles and the tile
 * description on 2026-10-20, they all sit on the styles' own host. If the
 * styles move a part to another host, a map scene fails naming the address,
 * and that host is added here once the styles are read again.
 */
export const BASEMAP_CONTENT_ORIGINS = ["https://tiles.openfreemap.org"];

/** Every origin a map scene may reach: the built-in styles' own and the
 * hosts they name. */
export const BASEMAP_ORIGINS = [...new Set([...BASEMAPS.map((style) => new URL(style.url).origin), ...BASEMAP_CONTENT_ORIGINS])];

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** Whether an address belongs to the built-in basemap. */
export const isBasemap = (url) => BASEMAP_ORIGINS.includes(originOf(url));

/**
 * Whether a scene's page may make a request: to the instance's own origin
 * always, to the built-in basemap only in a scene that shows a map, and
 * anywhere else never.
 */
export function mayRequest(url, { origin, map = false }) {
  const target = originOf(url);
  if (target === null) return false;
  if (target === origin) return true;
  return map === true && BASEMAP_ORIGINS.includes(target);
}

/**
 * Where a basemap answer's content comes from, as a run reports it: a
 * built-in style by its address, tiles by their tile set's address (the path
 * before the tile's zoom, column and row), and anything else (the tile
 * description, glyphs and sprites, which follow from the style) as null. The
 * basemap's provider moves its tiles to a new set when it publishes new map
 * data, so two runs that drew the same styles and tile sets drew the same
 * basemap, and a map picture that changed between runs that did not is the
 * basemap's change, not the app's.
 */
export function basemapSource(url) {
  if (BASEMAPS.some((style) => style.url === url)) return url;
  const tiles = /^(https:\/\/[^/]+\/.+\/)\d+\/\d+\/\d+(?:@2x)?\.\w+$/.exec(url);
  return tiles ? tiles[1] : null;
}

/**
 * The run's watch over a browser context's requests, one scene at a time.
 * `begin(scene)` names the scene being taken; `route` refuses (and writes
 * down) every request the scene may not make and lets the rest go;
 * `failed` and `answered` take the context's failed requests and answers
 * and write down a basemap request that failed or answered with an error.
 * A request the page itself gave up on (the map cancels a tile it no
 * longer needs) is not a failure. `end()` returns what the scene got wrong
 * and forgets the scene. `sources()` lists the basemap's styles and tile
 * sets that answered in the context's map scenes (`basemapSource`).
 */
export function sceneNetwork(origin) {
  let scene = null;
  let problems = [];
  const sources = new Set();
  const allowedBasemap = (url) => scene?.map === true && isBasemap(url);
  return {
    begin(next) {
      scene = next;
      problems = [];
    },
    route(route) {
      const url = route.request().url();
      if (mayRequest(url, { origin, map: scene?.map === true })) return route.continue();
      problems.push({ kind: "refused", url });
      return route.abort();
    },
    failed(request) {
      const url = request.url();
      const reason = request.failure()?.errorText ?? "failed";
      if (!allowedBasemap(url) || reason === "net::ERR_ABORTED") return;
      problems.push({ kind: "failed", url, reason });
    },
    answered(response) {
      const url = response.url();
      if (!allowedBasemap(url)) return;
      if (response.status() >= 400) {
        problems.push({ kind: "failed", url, reason: `answered ${response.status()}` });
        return;
      }
      const source = basemapSource(url);
      if (source) sources.add(source);
    },
    end() {
      const found = problems;
      scene = null;
      problems = [];
      return found;
    },
    sources() {
      return [...sources].sort();
    },
  };
}

/** How many addresses a message lists of each kind before it counts the
 * rest. */
const LISTED = 12;

const listed = (lines) => {
  const unique = [...new Set(lines)];
  const shown = unique.slice(0, LISTED).map((line) => `  ${line}`);
  if (unique.length > LISTED) shown.push(`  and ${unique.length - LISTED} more`);
  return shown.join("\n");
};

/** What a scene's problems in a take say, naming every address (up to a
 * dozen of each kind, then a count). */
export function problemsMessage(scene, problems, { theme } = {}) {
  const name = theme ? `${scene.id} (${theme} take)` : scene.id;
  const refused = problems.filter((problem) => problem.kind === "refused").map((problem) => problem.url);
  const failed = problems.filter((problem) => problem.kind === "failed").map((problem) => `${problem.url} (${problem.reason})`);
  const parts = [];
  if (refused.length) {
    const allowed = scene.map === true ? "off the instance and off the built-in basemap" : "off the instance";
    parts.push(`${name}: the page asked for addresses ${allowed}, which the run refuses:\n${listed(refused)}`);
    if (scene.map !== true && refused.some(isBasemap)) parts.push(`${name}: the built-in basemap is reached only from a scene that shows a map, declared with map: true.`);
  }
  if (failed.length) parts.push(`${name}: the built-in basemap did not load:\n${listed(failed)}`);
  return parts.join("\n");
}

/**
 * The server's requests, as its observer wrote them, that went somewhere
 * other than the instance itself. The server asks its own listener whether
 * it is answering before it makes map card pictures, which stays inside the
 * run; a request to any other host does not.
 */
export function requestsOffInstance(rows, base) {
  const own = new URL(base).host;
  return rows.filter((row) => row.host !== own);
}
