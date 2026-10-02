# Architecture

Dezfil is one container. Inside it are a web application, an embedded
metadata database, and a spatial query engine that reads files. There is no
external database to provision, no job runner, no cache server, and no
second service. Everything durable is a file under one directory, so backup
is a copy and moving machines is a copy.

## The shape

```
                    browser
                       |
     React UI  +  deck.gl over MapLibre GL
                       |  HTTP, /api/...
  -------------------------------------------------------------
   one container (Next.js server, Node)
                       |
     API route handlers  ->  service modules
                       |            |
        metadata (SQLite)      query boundary
                       |            |
                       |     +------+------+
                       |     |             |
                       | trusted DuckDB  hardened DuckDB
                       |  (ingest, admin) (user SQL only)
                       |     |             |
  -------------------------------------------------------------
   the data directory
     metadata.sqlite   tables/*.parquet   tiles/*.pmtiles
     secret.key        thumbnails/        cache/   tmp/  exports/
```

The engine never holds durable state. Both engine instances run in memory;
everything that must survive a restart is a file on the volume.

## The request path

Every capability is an HTTP endpoint, and the interface is a client of it.
Rendering one layer in the builder walks the whole stack:

1. The page under `src/app/(workspace)/maps/[id]/page.tsx` renders the
   builder component.
2. The builder asks for render data per layer, through a small fetch helper
   (`src/components/builder/render-data.ts`) that calls
   `GET /api/layers/{id}/render`. A failed render is a layer state, not a
   page error.
3. The route handler (`src/app/api/layers/[id]/render/route.ts`) loads the
   layer and calls the service, passing the request's abort signal down.
4. `src/lib/layer-service.ts` compiles the effective query: the layer's own
   SQL, refined by its filters, then aggregated according to its
   visualization. It counts features and decides whether to answer inline or
   to switch to tiles.
5. `src/lib/query/bounded.ts` is the single door to user SQL. It takes a
   connection on the hardened instance under a wall-clock budget, registers
   the datasets as views, runs the work, and interrupts on timeout or on the
   caller going away.
6. The hardened engine reads the GeoParquet files under the data directory.
7. The response feeds deck.gl layers composited onto the MapLibre map.

The published viewer and the SQL workspace take the same path with a
different door: a publication token in place of a layer id, or
`POST /api/query` in place of the render route. There is no shortcut from
the interface to the engine, which is why a headless script can drive the
whole product.

## Two engine instances

The query engine is DuckDB with its spatial extension, embedded in the
server process through its Node bindings (`src/lib/duckdb.ts`). There are
two instances, both in memory, and keeping them apart means hardening user
queries can never break trusted work.

**The trusted instance** does ingest and inspection: reading an uploaded
file, writing a dataset artifact, measuring it.

**The hardened instance** runs user SQL and nothing else. At creation it
loads its extensions, then closes the door behind them:

- the filesystem is fenced to the dataset directory and the tile scratch
  directory, and nothing else is reachable;
- external access is disabled, so the engine cannot open the network;
- further extension installation and autoloading are disabled;
- a memory budget is applied, and spilling to disk is switched off so that
  exceeding the budget is a clean coded failure rather than a slow grind;
- the configuration is then locked, so none of the above can be changed by a
  statement.

Before any statement reaches it, a guard requires exactly one read-only
`SELECT`, classified with the engine's own parser rather than a keyword
blocklist (`src/lib/query/guard.ts`). Datasets are exposed as views over
their files, so user SQL sees names and never paths.

There is no browser-side query engine. Every query runs on the server.

## Where the files live

The data directory is `DEZFIL_DATA_DIR`, which defaults to `data` beside
the working directory and is `/data` in the container. At boot the server
creates it and proves it writable (`src/lib/data-dir.ts`).

| Path | What it holds |
|---|---|
| `metadata.sqlite` | The metadata database. |
| `secret.key` | The generated at-rest encryption key, when none was configured. Created with owner-only permissions. |
| `tables/` | Dataset artifacts, one Parquet file per dataset, named by identifier. This is the durable form of every table. |
| `tiles/` | One PMTiles archive per tiled layer. |
| `tiles/scratch/` | The one place the hardened engine may write. Tile builds export here and the finished archive is renamed one level up. |
| `thumbnails/` | Map card images, with a small manifest per map when a map carries one image per theme. |
| `artifact-inputs/tiles/`, `artifact-inputs/thumbnails/` | What each tile archive and card image drew: the dataset identities and artifacts, one small file per archive or image. Lost evidence leaves its artifact unattributed, served to the map's owner alone. |
| `exports/` | Staging for project exports. Old siblings are swept as new ones are assembled. |
| `cache/overpass/`, `cache/geocode/`, `cache/isochrone/` | Provider answer caches, each with its own size and freshness budget. |
| `tmp/` | Scratch for uploads, downloads and exports in flight. Swept whole at boot. |
| `assistant-models.json` | Optional, supplied by whoever runs the instance. Narrows the model catalogue. |

Drawn sketches are not a separate store: a draw session becomes an ordinary
dataset artifact under `tables/` plus one layer. Publishing writes no files
of its own; a published view reads the same artifacts, authorized against
metadata.

## Metadata

Map and layer metadata lives in an embedded SQLite database, opened through
one module (`src/lib/metadata/db.ts`) with write-ahead logging and foreign
keys on. Schema changes are an ordered list of migration statements applied
by version number, each inside its own transaction. A statement that needs a
value derived by the application's own rules, such as an account's SQL name,
calls it as a SQL function the migration runner registers on the connection.
There is no migration library and no external tool.

Keeping metadata embedded is what preserves the one-container promise. The
repository modules beside `db.ts` deliberately keep their SQL portable, so
moving to a server database later would touch that folder and nothing else.
Each repository owns one concern: datasets, maps and layers, tile build
records, workflows and their steps, canvas layouts, cascades, run records,
lineage edges, per-map undo history, projects, connections, palettes, and
settings.

## A layer is its SQL

A layer is its SQL text plus a style. The record carries the statement, a
name, the style, visibility, ordinal position within the map, the filters
applied to it, the visualization type, tooltip and popup fields, the fields
a publication may expose, and the legend's title and labels
(`src/lib/metadata/maps.ts`). The map owns layer order, visibility and the
viewport.

Nothing renders from a cached feature collection that has drifted from its
query. Changing the SQL changes the layer, and the effective query is
recomputed from the statement, its filters and its visualization each time.

## Large layers become tiles

Under the render cap a layer answers as inline features. Over it, a simple
point layer switches to a tiled render instead (`src/lib/layer-service.ts`).
Aggregations and heatmaps do not: past the cap they answer a coded error
naming the bound, because silently sampling an aggregate would be a lie.

A tile build runs in two stages (`src/lib/tiles/build.ts`). The effective
query is exported to newline-delimited GeoJSON in the scratch directory, the
one writable spot the hardened engine has. Then the tile builder turns that
into a PMTiles archive of vector tiles, and the finished archive is renamed
into place so the previous one keeps serving until the instant it is
replaced.

Freshness is a fingerprint over the effective query plus the dataset
identities its evaluation bound, each with its current artifact, so
restyling never looks like a data change and a data change never fails to
look like one. The build records those identities beside the archive
(`src/lib/tiles/evidence.ts`), from the export's own evaluation
(`src/lib/query/evaluation-inputs.ts`); a refresh or deletion of a dataset
finds the layers whose tiles drew it by that record. Builds queue per layer
and per requesting reach: the layer's record names only the archive being
served, a failure stays with the attempt that failed, and only a committed
build replaces the archive. The application serves tiles
itself by reading byte ranges out of the archive
(`src/lib/tiles/serve.ts`); there is no tile server.

## Rendering

The canvas is deck.gl drawing over a MapLibre GL basemap, composited
through deck.gl's MapLibre overlay bridge. `src/components/map/MapCanvas.tsx`
coordinates the map; `src/components/map/canvas-overlay.ts` owns the separate
data canvas and its capture lifetime. The default basemap is a keyless
public vector style, with light, streets and imagery alternatives, and an
instance can pin its own style URL for an air-gapped deployment
(`src/lib/basemap.ts`).

The renderer's ESM worker and shared chunk are served from the application
origin under `public/workers/`. `src/lib/maplibre.ts` configures their URL
before maps are constructed, so bundled pages and offline image exports
use the same assets. Their bytes are checked against the installed package
in the unit suite and against the built container by its inventory check.

## Hexagons and H3

These are two different things and the code keeps them apart.

**H3** is available through the engine's community extension, baked into
the image, and used for index-based work: hexagon cell columns, hotspot
statistics, and recognizing H3 cell text when a file is imported. There is
no H3 library in the browser bundle.

**The map's hex bin is not H3.** It is a planar hexagon tessellation in
projected meters (`src/lib/hex-bin.ts`), because a fixed resolution ladder
cannot give the in-between cell sizes a map actually needs. The same maths
exists twice on purpose, once in SQL for the authoritative aggregation and
once in TypeScript for the interactive preview, so the two agree.

## Repository layout

| Path | What it holds |
|---|---|
| `src/app/` | Routes. The workspace pages, the published viewer, the bare page the image exporter screenshots, and every API route handler under `src/app/api/`. |
| `src/components/` | The interface: the builder and its panels, the map canvas, the workflow canvas, screens and dialogs. |
| `src/lib/` | Everything else: services, the metadata repositories, ingest, operations, tiles, publishing, the query boundary and the engine, the API description, the agent tool layer and the MCP server. |
| `e2e/` | Browser journeys and their snapshots. |
| `scripts/` | Tooling: the custom lint checks, the engine extension bake and its offline proof, headless journeys, packaging. |
| `public/` | Static runtime assets: basemap definitions, icon sprites, logos, the vector tile parser worker. |
| `plugins/dezfil/` | The distributable agent plugin package. |
| `test-support/` | Fixture builders for the test suites. |
| `docs/` | These documents and the runbook. |
| `design/` | The identity sheet. |

Top-level files worth knowing: `Dockerfile` builds the single image,
`README.md` is the quick start and the configuration table, `NOTICE` carries
the attribution for borrowed code, and `LICENSE` is Apache 2.0.

## The container

One image, built in stages from a Debian-based Node base because the
engine's native bindings target that C library. The build compiles the tile
builder from source and bakes the engine's extensions into the image, so a
running instance needs no network to load them.

The final image carries the application, the baked extensions, the tile
builder, and a headless browser used only to render image exports of the
instance's own pages. It runs as an unprivileged user, listens on port 3000,
and declares `/data` as its volume.
