/**
 * Sentences both sides of the layer road say — and **nothing else**.
 *
 * This module imports nothing on purpose. Its one job is to be safe for a
 * client component to import, so the copy the SQL page shows and the copy the
 * server's layer validation answers with can be one string without the
 * client's bundle reaching for the engine.
 *
 * That is not hypothetical. The sentence below lived in three places — the
 * server's validation, the SQL page's disabled action, and a browser assertion
 * that typed it out a third time — and they drifted, which left the assertion
 * red against working code. The first repair re-exported it from
 * `layer-geometry.ts`, which imports the bounded-evaluation boundary and so
 * DuckDB; the SQL console is a client component, and the cross-model
 * review was right that it should not be one bundler decision away from the
 * native bindings. Hence a module with no imports at all.
 */

/**
 * Why a result cannot become a layer.
 *
 * Said by the server when a layer is asked for a result with no geometry, and
 * by the SQL page on its disabled *Add as map layer* action. One string, so a
 * user who meets it twice meets it once.
 */
export const NOT_MAPPABLE_COPY =
  "A layer needs a geometry column. This result has none, so it cannot " +
  "become a layer, but it can still be saved as a dataset. Add geometry " +
  "with a spatial function (e.g. ST_Point) if you want it on the map.";
