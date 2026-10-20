---
title: "Architecture"
summary: "Find where each part of the Dezfil container lives in the source, and keep the rules that hold the parts together."
read_when:
  - "you change the code or the Dockerfile and need to know where a part lives or what the image carries"
  - "you wonder why Dezfil needs no database server or second service"
  - "you trace a layer from the browser to the query engine and back"
  - "you add a feature and want to know which rules it must keep"
  - "you add an API operation and want the UI, the assistant and MCP clients to get it"
audience:
  - developer
  - agent
checked: none
order: 2
moved_from:
  - "/docs/develop/architecture/"
---

Dezfil is one Node.js server in one container. It keeps everything it stores in one data folder:

```text title="One container"
 browser                                   AI agent
 React UI, deck.gl over MapLibre GL        any MCP client
      |                                         |
      | HTTP /api/...                           | HTTP /api/mcp
+-----|-----------------------------------------|---------------+
|     v       Next.js server, port 3000         v               |
|  pages and API routes  <------ HTTP ------  MCP endpoint      |
|     |                                                         |
|     v                                                         |
|  service modules                                              |
|     |             |              |              |             |
|     v             v              v              v             |
|  SQLite        DuckDB         DuckDB         picture renderer |
|  metadata      trusted:       hardened:      (Chromium) and   |
|  store         imports and    user SQL,      tile builder     |
|                inspection     read-only      (tippecanoe)     |
|     |             |              |              |             |
+-----|-------------|--------------|--------------|-------------+
      v             v              v              v
  data folder:  metadata.sqlite   tables/ (GeoParquet)
                tiles/ (PMTiles)  thumbnails/
```

Both DuckDB instances run in memory, and the metadata store is a SQLite file. What must outlive a restart is a file in the data folder, so there is no database server to run, and a backup is a copy of that folder.

The data folder is `DEZFIL_DATA_DIR`: `/data` in the container, `./data` in a checkout. [Back up and restore](../self-host/backup-and-restore.md) lists what it holds.

## The parts in the source

| Part | In the source | Its job |
|---|---|---|
| Pages | `src/app/(workspace)/`, `src/app/(entry)/`, `src/app/v/`, `src/components/` | The React screens: the workspace, the entry pages (sign-in, setup, accepting a link) and the published viewer at `/v/<token>` |
| Map canvas | `src/components/map/` | deck.gl layers drawn over a MapLibre GL basemap |
| API routes | `src/app/api/` | Every HTTP operation, one `route.ts` per path. The sign-in gate in `src/proxy.ts` refuses a request that needs a sign-in and has none. A handler checks what the caller may reach and calls the service modules. |
| Service modules | `src/lib/` | The work behind the routes: imports, layers, tiles, operations, publishing, sharing |
| API description | `src/lib/api/openapi.ts` and the `openapi-*.ts` files beside it | The OpenAPI description, served at `GET /api/openapi.json` and written to `docs/api/openapi.json` |
| Metadata store | `src/lib/metadata/` | Accounts, maps, layers, projects, workflows and settings in `metadata.sqlite`, with the migrations that build it |
| Trusted DuckDB | `src/lib/duckdb.ts`, `src/lib/trusted-*.ts`, `src/lib/ingest/` | Reads imported files and writes each dataset as one GeoParquet file in `tables/` |
| Hardened DuckDB | `src/lib/duckdb.ts`, `src/lib/query/` | Runs user SQL and every layer's query, fenced to `tables/` and the tile scratch folder |
| Tile builder | `src/lib/tiles/` | Builds a PMTiles archive with tippecanoe for a large point layer, and serves its tiles from the archive |
| Picture renderer | `src/lib/export/`, `src/lib/pictures/`, `src/app/render/` | Headless Chromium opens the app's own render page and takes a screenshot, for image exports and the pictures on map cards |
| MCP endpoint | `src/app/api/mcp/`, `src/lib/mcp/`, `src/lib/tools/` | The documented operations as MCP tools. Each tool call is an HTTP request to the API. |
| Assistant | `src/lib/assistant/` | The in-app assistant, which calls the same tools as an MCP client |
| Startup | `src/instrumentation.ts` | Checks that the data folder is writable, opens the metadata store, removes leftover files, settles interrupted runs and starts the map picture work |

## The container image

The [Dockerfile](../../Dockerfile) builds the image in stages on `node:24-slim`. Its last stage holds everything the server runs, so the server starts, and its engine loads every extension, with no network. [What leaves the instance](../self-host/what-leaves-the-instance.md) lists the requests a running instance can make.

| In the image | Where | What it is for |
|---|---|---|
| The production build, as the Next.js standalone server | `/app` | The pages, the API and the MCP endpoint |
| `tippecanoe` 2.79.0, compiled in a build stage of its own | `/usr/local/bin/tippecanoe` | The tiles of large layers |
| Chromium, a certificate bundle and the Liberation fonts | `/usr/bin/chromium`, named by `DEZFIL_CHROMIUM_PATH` | Image exports, the pictures on map cards and the look at a map the assistant or an agent asks for, drawn with software GL |
| The engine's extensions: spatial, h3, httpfs, json, postgres, azure and aws | `/app/duckdb-extensions`, named by `DUCKDB_EXTENSION_DIR` | Installed at build time by `scripts/install-duckdb-extensions.mjs` from the one list in `scripts/duckdb-extensions.mjs`, which the offline check reads too |
| The native packages the standalone build leaves out: `@duckdb`, `better-sqlite3`, `bindings` and `file-uri-to-path` | `/app/node_modules/` | The engine's and the metadata store's native code, copied whole |
| `public/`, the model catalogue and the shipped templates | At their paths in the source | Read at run time where the source keeps them |
| `LICENSE` and `NOTICE` | `/app` | The licences of the code and the components the image carries |
| The ingress preload and the account recovery script, with the modules they import | `/app/scripts/`, `/app/src/lib/auth/` | The preload starts before the server; an operator runs the recovery script |

The image runs as the unprivileged `node` user, listens on port 3000 and keeps its data in the `/data` volume. [Development setup](development-setup.md#build-and-check-the-image) builds it and runs its two checks.

## Follow a layer from the browser and back

1. The builder asks for each layer's data with `GET /api/layers/<id>/render`, in `src/components/builder/render-data.ts`.
2. The route, `src/app/api/layers/[id]/render/route.ts`, checks that the caller can reach the layer and passes the request's abort signal on.
3. `src/lib/layer-render.ts` builds the effective query with `src/lib/query/compile.ts`: the layer's SQL, refined by its filters, then aggregated by its visualization.
4. `src/lib/query/bounded.ts` runs it on the hardened instance within a time budget. It stops the engine when the budget runs out or the caller leaves.
5. The answer carries GeoJSON for deck.gl. A point layer over the [render limits](../api/limits.md) answers with tiles instead, which `src/lib/tiles/build.ts` builds in the background.

The SQL workspace takes the same road through `POST /api/query`, and a published map through `GET /api/published/<token>`. The browser reaches the engine only through the API.

## Rules every change keeps

- **One container, one data folder:** a feature that needs a second service, such as a database server, a cache or a job runner, does not fit. Durable state is a file in the data folder, never inside an engine.
- **DuckDB on the server only:** there is no query engine in the browser. The client calls the API, and the server's engine works on data larger than browser memory.
- **User SQL on the hardened instance:** at its start it loads its extensions, fences the filesystem, sets a memory limit with no spilling to disk, turns off network access and extension loading, then locks its configuration. Never widen it to make a feature easier.
- **One read-only statement:** `src/lib/query/guard.ts` admits exactly one `SELECT`, classified by DuckDB's own parser rather than a list of keywords. `src/lib/query/guard.test.ts` holds it.
- **SQL is the source of truth for a layer:** a layer is its SQL, a name and a style. Style draws the query's result and never becomes a second query. Rendering, classification, field statistics and publishing all build the effective query in `src/lib/query/compile.ts`.
- **Every capability is an API the UI calls:** new behavior starts as a documented operation with a route behind it. `src/lib/api/parity.test.ts` fails on a route without an operation, an operation without a route, or a UI call to an undocumented path.
- **The API description is a published contract:** a renamed path, field or error code is a breaking change. If an agent would need a warning, change the API until the mistake is impossible or harmless.
- **MCP tools come from the API description:** `src/lib/tools/tools.ts` makes one tool of each documented operation that names one in its `x-tool` extension. `src/lib/tools/tools.test.ts` fails when the two drift apart.

After you change the description, run `npm run docs:write` to write `docs/api/openapi.json` again. `npm run lint:docs` fails while that file is stale.

> [!NOTE]
> The map's hex bin is a flat hexagon grid at any cell size, not H3. `src/lib/query/compile.ts` builds it in SQL with the math of `src/lib/hex-bin.ts`. H3, through DuckDB's extension, serves index-based work, such as the **Assign H3 cells** tool.

## Next steps

- [Development setup](development-setup.md): run a checkout, the checks and the tests.
- [How this is built](how-this-is-built.md): take a change from an idea to a merged pull request.
- [How the API works](../api/http-api.md): sign-in, edit revisions and errors for every client of the API.
- [Connect an AI agent](../api/mcp.md): use the MCP endpoint from Claude Code, Codex or Cursor.
