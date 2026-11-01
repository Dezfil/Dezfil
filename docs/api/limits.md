---
title: "Limits"
summary: "Find every limit Dezfil holds requests to, what you get when you reach one, and the setting that changes it."
read_when:
  - "a request answers 408, 409, 413, 422, 429 or 507 and you want to know which limit it reached"
  - "a query shows only its first rows, or answers query_result_too_large"
  - "you want to raise the largest upload, the query time limit or another limit"
  - "an assistant message, an agent's upload or a tool's download is too large"
  - "visitors to a published map get rate_limited"
audience:
  - developer
  - agent
  - operator
checked: none
moved_from:
  - "/docs/reference/sql-limits/"
order: 5
---

At a limit, Dezfil cuts an answer short and says so, or refuses with a status and error code.

Try the first kind. This query asks for 1,001 rows, one more than a query's answer holds unless an admin changes it:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/query \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT range AS n FROM range(1001)"}' \
  | jq -c '{rowCount, shown: (.preview | length), previewTruncated}'
```

`jq -c` prints three parts of the answer on one line. Install [jq](https://jqlang.org) if your system lacks it.
:::
:::tab[JavaScript]
```js title="rows.mjs"
const response = await fetch("http://localhost:3000/api/query", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sql: "SELECT range AS n FROM range(1001)" }),
});
const result = await response.json();
console.log(JSON.stringify({ rowCount: result.rowCount, shown: result.preview.length, previewTruncated: result.previewTruncated }));
```

Run it with `node rows.mjs`.
:::
::::

```json title="Output"
{"rowCount":1001,"shown":1000,"previewTruncated":true}
```

- `<YOUR_TOKEN>` is your API token. The [API quickstart](quickstart.md) shows how to create one.
- `range(1001)` makes 1,001 numbered rows, so you need no dataset to try it.
- `rowCount` counts every row of the result.
- `preview` holds the first rows, up to **Rows shown in results**, and `previewTruncated` is `true` when rows were left out.

On the **SQL** page the same query shows **Showing the first 1,000 of 1,001 rows. Save as dataset or Download to keep them all.** Both take every row.

## What you get at a limit

| At the limit | You get | For example |
|---|---|---|
| An answer with more rows or features than it holds | The answer, with a field that says it is cut short | `previewTruncated: true` |
| A request over a size | A 4xx status and an error code, before any work. Nothing changes. | 413 `upload_too_large` |
| An answer, or the work, over a size or memory budget | 422, or 400 for the memory of people's SQL, and a code. No part of the answer comes back. | 422 `query_result_too_large` |
| Work that runs past its time | 408, or 504 for a link import's download, and a code that names the limit. The work stops. | 408 `query_timeout` |
| A creation at the instance count limit | 409 `instance_limit_reached`. Nothing is created. | A new map when the instance holds its map limit |
| Storage at or below its free-space threshold | 409 `storage_full`, before new file work starts | An upload with too little space left |
| A volume that refuses an admitted write | 507 `storage_exhausted`; partial files are removed | A conversion that fills the disk |
| A full queue, or too many requests | 409, 429 or 503. Retry later. | 429 `rate_limited` |

An MB, here, in **Settings** and in Dezfil's messages, is 1,048,576 bytes, a MiB: the 32 MB that `query_result_too_large` names is 33,554,432 bytes. Only **Engine memory** and **Trusted engine memory** count an MB as 1,000,000 bytes.

Most refusals at a setting's limit say in their `message` which setting changes it, such as `An admin can change "Query time limit".` A few call the setting by another name than **Settings** › **Limits** does: the `label` that `GET /api/instance/settings` gives each setting is the one the message uses. [Errors](errors.md) shows the parts of an error answer.

## Limits an operator changes

An admin changes most limits in **Settings** › **Limits**. A row with a lock is decided by the server: the line under it names the variable that changes it. **Largest image** and **Storage full at** are fixed.

From a script, send the new value with `<YOUR_ADMIN_TOKEN>`, a token an admin's account created; any other account's token answers 403 `forbidden`:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s -X PATCH http://localhost:3000/api/instance/settings \
  -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"previewRows": 2000}' \
  | jq -c '.settings.previewRows | {value, source, locked}'
```
:::
:::tab[JavaScript]
```js title="change-limit.mjs"
const response = await fetch("http://localhost:3000/api/instance/settings", {
  method: "PATCH",
  headers: {
    Authorization: "Bearer <YOUR_ADMIN_TOKEN>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ previewRows: 2000 }),
});
const { value, source, locked } = (await response.json()).settings.previewRows;
console.log(JSON.stringify({ value, source, locked }));
```

Run it with `node change-limit.mjs`.
:::
::::

```json title="Output"
{"value":2000,"source":"stored","locked":false}
```

- `previewRows` is the key of **Rows shown in results**. The table below gives each limit's key and variable.
- `source` is `stored` for a value saved in **Settings**, `environment` for a variable, or `default`.
- A key that a variable sets answers 409 `setting_locked`, and nothing changes.
- To go back to the default, send `{"previewRows": null}`.

Read `previewRows` and `renderCapFeatures` through `GET /api/config`.

> [!NOTE]
> A change applies to new work. A query, upload or tool run that has already started keeps the limit it started with.

[Configuration](../self-host/configuration.md) shows how to set a variable and which value wins.

<!-- settings-limits:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Largest upload** | `DEZFIL_UPLOAD_MAX_MB` | `uploadMaxMb` | `5120` MB | 1 to 102,400 in Settings; any number above 0 as a variable | Size cap for one uploaded file. | In Settings, live; by variable, after a restart |
| **Data processing time limit** | `DEZFIL_DATA_PROCESSING_TIMEOUT_S` | `dataProcessingTimeoutS` | `3600` seconds | 60 to 21,600 in Settings; any number above 0 as a variable | Time to receive one upload, and, counted apart, time for one data processing job, such as an import. | In Settings, live; by variable, after a restart |
| **Largest link import** | `DEZFIL_REMOTE_MAX_MB` | `remoteMaxMb` | `2048` MB | 1 to 102,400 in Settings; any number above 0 as a variable | Size cap for a URL or object-store import. | In Settings, live; by variable, after a restart |
| **Link import time limit** | `DEZFIL_REMOTE_TIMEOUT_S` | `remoteTimeoutS` | `300` seconds | 10 to 3,600 in Settings; any number above 0 as a variable | Time for one link import's whole download. | In Settings, live; by variable, after a restart |
| **OpenStreetMap area** | `DEZFIL_OSM_MAX_KM2` | `osmMaxKm2` | `10000` km² | 1 to 1,000,000 in Settings; any number above 0 as a variable | The largest area one OpenStreetMap import may cover. | In Settings, live; by variable, after a restart |
| **Overture area** | `DEZFIL_OVERTURE_MAX_KM2` | `overtureMaxKm2` | `25000` km² | 1 to 1,000,000 in Settings; any number above 0 as a variable | The largest area one Overture import of places may cover; other themes may cover more or less, by how dense they are. | In Settings, live; by variable, after a restart |
| **Query time limit** | `DEZFIL_QUERY_TIMEOUT_S` | `queryTimeoutS` | `60` seconds | 5 to 600 in Settings; any number above 0 as a variable | Time for one query, whether the SQL people run, a layer, an inspection, a preview or a published map. | In Settings, live; by variable, after a restart |
| **Rows shown in results** | `DEZFIL_PREVIEW_ROWS` | `previewRows` | `1000` rows | 10 to 100,000 in Settings; any number above 0 as a variable | Row cap for result previews. | In Settings, live; by variable, after a restart |
| **Features drawn per layer** | `DEZFIL_RENDER_CAP_FEATURES` |  | `250000` features | Any number above 0 | The most features a layer draws, and the count past which a points layer is drawn from tiles. | By variable, after a restart |
| **Bytes drawn per layer** | `DEZFIL_RENDER_CAP_BYTES` |  | `134217728` bytes | Any number above 0, rounded down to a whole number of at least 1 | The largest answer one layer may draw from, in bytes of uncompressed JSON. | By variable, after a restart |
| **Tools running at once** | `DEZFIL_OPERATION_CONCURRENCY` | `operationConcurrency` | `1` | 1 to 8 in Settings; any number above 0 as a variable, rounded down to a whole number of at least 1 | Tool runs at the same time; they share the engine that runs people's SQL. | In Settings, live; by variable, after a restart |
| **Tools waiting** | `DEZFIL_OPERATION_QUEUE_MAX` | `operationQueueMax` | `20` | 1 to 200 in Settings; any number above 0 as a variable, rounded down to a whole number of at least 1 | Tool runs that may wait for a turn. | In Settings, live; by variable, after a restart |
| **Time limit per tool run** | `DEZFIL_OPERATION_TIMEOUT_S` | `operationTimeoutS` | `600` seconds | 30 to 7,200 in Settings; any number above 0 as a variable | Time for one tool run, not counting its wait for a turn. | In Settings, live; by variable, after a restart |
| **Images at once** | `DEZFIL_EXPORT_RENDER_CONCURRENCY` | `exportRenderConcurrency` | `2` | 1 to 8 in Settings; any number above 0 as a variable, rounded down to a whole number of at least 1 | Images the server draws at the same time. | In Settings, live; by variable, after a restart |
| **Time limit per image** | `DEZFIL_EXPORT_RENDER_TIMEOUT_S` | `exportRenderTimeoutS` | `90` seconds | 10 to 300 in Settings; any number above 0 as a variable | Time for one image, its wait for a turn included. | In Settings, live; by variable, after a restart |
| **Requests per visitor** | `DEZFIL_PUBLIC_RATE_LIMIT` | `publicRateLimit` | `60` every 10 seconds | 1 to 10,000 in Settings; any number above 0 as a variable | Requests one visitor may make to published maps, counted by network address across every published map. | In Settings, live; by variable, after a restart |
| **Tile requests per visitor** | `DEZFIL_PUBLIC_TILE_RATE_LIMIT` | `publicTileRateLimit` | `600` every 10 seconds | 1 to 100,000 in Settings; any number above 0 as a variable | Tile requests one visitor may make to published maps, counted by network address across every published map. | In Settings, live; by variable, after a restart |
| **Maps on this instance** | `DEZFIL_MAPS_LIMIT` | `mapsLimit` | `0` | 0 to 9,007,199,254,740,991 in Settings; a whole number from 0 to 9,007,199,254,740,991 as a variable | Every map, including duplicates and template copies. Zero means no limit. | In Settings, live; by variable, after a restart |
| **Projects on this instance** | `DEZFIL_PROJECTS_LIMIT` | `projectsLimit` | `0` | 0 to 9,007,199,254,740,991 in Settings; a whole number from 0 to 9,007,199,254,740,991 as a variable | Every project. Zero means no limit. | In Settings, live; by variable, after a restart |
| **People on this instance** | `DEZFIL_PEOPLE_LIMIT` | `peopleLimit` | `0` | 0 to 9,007,199,254,740,991 in Settings; a whole number from 0 to 9,007,199,254,740,991 as a variable | Invited, active and deactivated accounts and unfinished deletions. Zero means no limit. | In Settings, live; by variable, after a restart |
| **Longest token lifetime** | `DEZFIL_TOKEN_LIFETIME_MAX` | `tokenLifetimeMax` | `none` | `none`, `30d`, `90d` or `1y` | The longest lifetime new tokens may take. None leaves the token rule unbounded. | In Settings, live; by variable, after a restart |
| **Engine memory** | `DEZFIL_QUERY_MEMORY_MB` |  | `2048` MB | Any number above 0 | Memory the engine that runs people's SQL may use, shared by every query. | By variable, after a restart |
| **Trusted engine memory** | `DEZFIL_TRUSTED_MEMORY_MB` |  | `3072` MB | Any number above 0 | Memory the engine that imports and processes data may use; it may spill up to four times this to disk. | By variable, after a restart |
| **Slider preview rows** | `DEZFIL_SLIDER_PREVIEW_ROWS` |  | `50000` rows | Any number above 0 | Source points transferred for interactive slider previews. | By variable, after a restart |
| **Published freshness** | `DEZFIL_PUBLISH_FRESHNESS_S` |  | `30` seconds | Any number above 0 | Cache window for published views. | By variable, after a restart |
| **Tile build time limit** | `DEZFIL_TILE_BUILD_TIMEOUT_S` |  | `600` seconds | Any number above 0 | Time budget for each background tile-build stage. | By variable, after a restart |
| **Image request time limit** | `DEZFIL_EXPORT_REQUEST_TIMEOUT_S` |  | `20` seconds | Any number above 0 | Deadline for each request made by the render page. | By variable, after a restart |
| **Tool attachment size** | `DEZFIL_TOOL_ATTACHMENT_MAX_MB` |  | `32` MB | Any number above 0 | The largest file a tool hands back to the assistant or an agent, such as an exported image. | By variable, after a restart |
| **Run history depth** | `DEZFIL_OPERATION_HISTORY_PER_SUBJECT` |  | `20` runs | Any number above 0, rounded down to a whole number of at least 1 | Runs kept in each run history, such as a workflow step's; its latest success is always kept. | By variable, after a restart |

<!-- settings-limits:end -->

## Storage space

| What | Fixed limit, no setting | When reached |
|---|---|---|
| Free space on the data folder's volume, **Storage full at** on the **This instance** card | At or below 512 MB | New file work answers 409 `storage_full` |
| A declared transfer | Its size must fit in the free space above 512 MB | Refused before reception |
| A transfer without a declared size | Capacity checked every 4 MB received | Stopped at the threshold; its partial file is removed |
| Work already admitted | No capacity reservation | Overlapping transfers and conversion output can fill the volume and answer 507 `storage_exhausted` |
| Space held for recovery | 64 MB, released in 8 MB portions | Used only after disk-heavy writers stop; exhausted recovery answers 507 `storage_exhausted` |

| Work while full | Behavior |
|---|---|
| Uploads, imports and refreshes from every source; saving SQL as a dataset; workflow runs; sketch changes | Refused before new file work |
| Layer and query exports; CSV and GeoJSON downloads; project export preparation | Refused. Downloading a dataset's existing GeoParquet file stays available. |
| Template downloads and copies; image exports; map and profile pictures | Refused. The previous picture stays. |
| Inline renders, usable tile archives and published pages | Readable. A layer needing a new archive answers `storage_full` in its initial errored-layer answer. |
| Map and layer saves, settings and token creation | Still admitted by the threshold |
| Signing in, revoking, unpublishing, cache clearing; deleting datasets, maps, workflows, projects and accounts | Use the recovery reserve if needed |
| Account compaction | Needs twice the metadata store's size free; deletion stays unfinished until space returns. |

| Read | Capacity field | Caching |
|---|---|---|
| Signed-in `GET /api/config` | `storage` | Fresh on every call |
| Admin `GET /api/instance/storage` | `state` | Fresh even when file counts are cached |

| Field | Meaning |
|---|---|
| `full` | Whether free bytes are at or below the threshold, compared before rounding |
| `free`, `total` | Bytes on the volume, rounded to the nearest MB |
| `threshold` | 536,870,912 bytes, the fixed 512 MB threshold |

See [Storage errors](errors.md#storage-errors).

## SQL results

| What | Limit | At the limit |
|---|---|---|
| Rows in a query's answer | **Rows shown in results** | The first rows, with `previewTruncated: true` |
| The whole answer, as JSON | 33,554,432 bytes (32 MiB) | 422 `query_result_too_large`, no rows |
| One value that is not geometry, as JSON | 2,097,152 bytes (2 MiB) | 422 `query_result_too_large`, no rows |
| Time for one query | **Query time limit** | 408 `query_timeout` |
| Memory, shared by every query | **Engine memory** | 400 `query_memory_exceeded` |
| A text value, or the WKT of a dataset's geometry, in a dataset inspection or a geometry-choice preview | 512 characters | Its first 512 and an ellipsis; the stored data stays whole |

A value over 2 MiB refuses the whole answer:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s -w "\n%{http_code}\n" http://localhost:3000/api/query \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"sql\": \"SELECT repeat('x', 3000000) AS value\"}"
```

```text title="Output"
{"error":{"code":"query_result_too_large","message":"The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value."}}
422
```
:::
:::tab[JavaScript]
```js title="too-large.mjs"
const response = await fetch("http://localhost:3000/api/query", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_TOKEN>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sql: "SELECT repeat('x', 3000000) AS value" }),
});
console.log(response.status, (await response.json()).error.code);
```

Run it with `node too-large.mjs`.

```text title="Output"
422 query_result_too_large
```
:::
::::

The two byte limits are fixed, with no setting. They hold four reads: the SQL console, dataset inspection, geometry-choice preview and the PostGIS five-row preview.

| Read | HTTP | MCP tool | Rows it shows |
|---|---|---|---|
| The SQL console, on the **SQL** page | `POST /api/query` | `run_sql` | **Rows shown in results** |
| A dataset inspection, on a dataset's page | `GET /api/tables/{name}` | `inspect_table` | 50 |
| The geometry-choice preview, in **Set geometry** | `POST /api/tables/{name}/geometry/preview` | `preview_table_geometry` | 50 |
| The PostGIS five-row preview | `POST /api/connections/postgis/{id}/preview` | `preview_postgis_relation` | 5 |

A value's quotes and escaping count toward its size. A geometry column counts toward the whole answer only, whether it travels as WKT or GeoJSON; in a dataset inspection, only the dataset's own geometry column does. Text that holds WKT or GeoJSON counts as text.

Row and engine-memory limits still apply: a result below both byte ceilings can fail the engine-memory limit while the query runs.

Downloads and saved datasets take the complete result. SQL, table and layer file exports stream every row, above both byte limits. [Errors](errors.md#answers-too-large-to-return) says what to do at each read.

An inspection that is still too large keeps the dataset's page and its **Set geometry** panel from opening. It also blocks tool column pickers, SQL schema inventory and completion, workflow dataset reads and facts, and automatic layer addition after a tool run.

A tool run can then report a failure even though the dataset has already been written. Existing layer rendering, dataset map features, file exports and deleting the dataset from **Data** use other reads and keep working. To open the dataset again, see [A dataset's page does not open](errors.md#a-datasets-page-does-not-open).

A filter's distinct values, a categorical classification, category widgets and value search hold each text value to 2 MiB too. The first two answer the same 422, a category widget shows the code as its own error, and value search names the layer under `refusedLayers` and leaves its rows out.

**Query time limit** must stay below **Time limit per tool run**.

## Uploads and imports

| What | Limit | At the limit |
|---|---|---|
| One uploaded file | **Largest upload** | 413 `upload_too_large` |
| A .zip or .kmz file, unpacked | **Largest upload** | 413 `archive_too_large` |
| Receiving an upload, then processing it, each | **Data processing time limit** | 408 `data_processing_timeout` |
| An upload that stops sending | 60 seconds without a byte | 408 `upload_stalled` |
| One import from a link or cloud storage | **Largest link import** | 413 `remote_too_large` |
| The download of a link import | **Link import time limit** | 504 `remote_timeout` |
| The area of an OpenStreetMap import | **OpenStreetMap area** | 413 `area_too_large` |
| The area of an Overture import | **Overture area**, by theme | 413 `area_too_large` |
| The answer of the OpenStreetMap server to an import | Twice **Overpass response budget** | 413 `remote_too_large` |
| The OpenStreetMap server's time to answer | **Time budget per query**, and 30 seconds more | 502 `remote_fetch_failed` |
| One statement of a PostGIS preview | 30 seconds, fixed | 408 `query_timeout` |
| Memory for imports and other data work | **Trusted engine memory** | 422 `engine_memory_exceeded` |
| A template's archive | 150 MB, and **Largest upload** unpacked | 413 `template_archive_too_large` or `template_unpacked_too_large` |
| A profile picture | 10 MB, fixed | 413 `upload_too_large` |
| A profile picture's size in pixels | 64 million, fixed | 413 `image_too_large` |
| Receiving a profile picture | 120 seconds, fixed | 408 `data_processing_timeout` |
| Processing a profile picture | 20 seconds with its wait for a turn, one at a time and eight waiting, fixed | 408 `data_processing_timeout`, or 503 `operation_queue_full` |

**Data processing time limit** also holds imports from links, OpenStreetMap, Overture and PostGIS, refreshes, geometry changes, template installs and exports of a dataset or a project.

When it runs out, the work stops, and data that was there before stays as it was.

**Time budget per query** and **Overpass response budget** are in [Data and services](../self-host/configuration/services.md), with their variables and defaults.

**Overture area** is the area for places. Each other theme takes a share of it:

| Overture theme | Largest area |
|---|---|
| Places | **Overture area** |
| Buildings, Addresses | A fifth of it |
| Transportation | Half of it |
| Base · land & water | Four times it |
| Divisions | Twenty times it |

A reverse proxy in front of Dezfil has a body limit of its own, which must allow your largest upload. [Reverse proxy and HTTPS](../self-host/reverse-proxy.md) shows how to set it.

## Layers, tools and images

| What | Limit | At the limit |
|---|---|---|
| Features in one layer | **Features drawn per layer** | A points layer draws as tiles. Another layer answers `render_cap_exceeded`. |
| One layer's answer, as JSON | **Bytes drawn per layer** | A points layer draws as tiles. Another layer answers `render_bytes_exceeded`. |
| A slider, Overture or OpenStreetMap preview, or a sketch's features, as JSON | **Bytes drawn per layer** | 422 `render_bytes_exceeded`, with no part of the answer |
| One stage of building a layer's tiles | **Tile build time limit** | The layer answers `tile_build_failed`, naming the time limit |
| Tools running at once | **Tools running at once** | Later runs wait |
| Tool runs waiting | **Tools waiting** | 503 `operation_queue_full` |
| One tool run, waiting not counted | **Time limit per tool run** | 408 `operation_timeout` |
| Runs of one workflow at once | 1 | 409 `run_in_flight` |
| Addresses in one geocode run | **Geocode addresses** | 400 `invalid_request` |
| Origins in one travel-time run | **Travel-time area** | 400 `invalid_request` |
| One side of an exported image | 4,096 pixels | 400 `invalid_request` |
| Images rendering at once | **Images at once** | Later images wait |
| One image, waiting included | **Time limit per image** | 408 `render_timeout` |

A layer that cannot draw still answers 200 from `GET /api/layers/{id}/render`. Its `ok` is `false`, and `error.code` names the limit. The map shows the layer as failed.

**Geocode addresses** and **Travel-time area** show how many one run takes at the current time limits, and grow with **Time limit per tool run**. They show on the **Tools** card of **Settings** › **Limits**, and **Largest image** on its **Image export** card. `GET /api/instance/settings` answers them as `capacities.geocodeRows`, `capacities.isochroneOrigins` and `maxImageDimension`.

## The assistant and agents

| What | Limit | At the limit |
|---|---|---|
| One message as sent, with its history and page context | 131,072 bytes (128 KiB) | 413 `assistant_submission_too_large` |
| The page context in a message | 64 KiB of JSON | 413 `assistant_context_too_large` |
| What Dezfil tells the model about the page | 96 KiB | Details are left out, then 413 `assistant_context_too_large` |
| Model and tool steps in one request | **Assistant steps** | The request ends with the event `{"type":"done","reason":"budget"}` |
| Requests open on the instance | 8 | 409 `assistant_capacity` |
| Requests open for one account | 4 | 409 `assistant_capacity` |
| Unsent reservations of one account | 2 | 409 `assistant_reservation_limit` |
| One map check, waiting included | **Map check time limit** | The check answers `render_timeout` |
| A reservation's life, unsent | 5 minutes | It expires |
| A download that a tool answers, over MCP or to the assistant | **Tool attachment size** | A failed tool result with the code `attachment_too_large` |
| One MCP request, an uploaded file inside it | 16,777,216 bytes (16 MiB) | 413 `request_body_too_large` |
| A file uploaded through MCP | About 12 MiB: three bytes for every four of the request left after its other parts. Also **Largest upload**. | 413 `request_body_too_large`, or `upload_too_large` over **Largest upload** |
| One page of the schema catalogue, `GET /api/catalogue/tables` | 96 KiB | 422 `catalogue_too_large` |

**Assistant steps** and **Map check time limit** are in the table of [Set up the assistant](../self-host/assistant.md#assistant-settings), with their variables and defaults; the other settings named here are in the table above.

In the app, a message over its limit shows **The message and its context are too large to send. Shorten the message.** On the **SQL** page, your editor text and a summary of your last run travel with every message, so a long draft counts too.

A reservation takes no place and stays after that refusal. A request holds a place from its message until it ends, waiting for your confirmation included.

When all eight are taken, the pane says **The assistant is at capacity: eight requests are open on this instance.** Four of your own read **You have four requests open, the most one person may.** `GET /api/assistant/pending` lists your waiting requests, and `DELETE /api/assistant/runs/{id}` frees one.

A detail Dezfil leaves out of what it tells the model comes with the address the model reads it from. When even the names do not fit, the message is refused.

To upload a bigger file, use **Add data** in the app or `POST /api/tables` over HTTP.

## Maps, projects and people

| Setting | What counts |
|---|---|
| **Maps on this instance** | Every map across all owners and projects, including duplicates and template copies. Installed templates do not count. |
| **Projects on this instance** | Every project. Copying a template creates a project too. |
| **People on this instance** | Invited, active, deactivated and deleting accounts, plus readable unfinished deletion journals, counted once per person. A finished deletion's retained identity does not count. |

| Situation | What happens |
|---|---|
| Nothing set | Each count limit defaults to `0`, meaning no limit. |
| A limit below the count | Nothing is deleted. Reading, editing, sharing, publishing, unpublishing, exporting and deleting continue. Ownership transfers change no count. |
| Creation at or above a limit | `409 instance_limit_reached`. A refused template copy keeps its installation and creates no project, map or dataset. Delete an item or raise the limit. The message names the editable setting, or its locking variable and a restart. |
| An unfinished account deletion | It occupies a place even after profile erasure. Finish it through [Users](../self-host/users.md#a-row-says-deletion-unfinished). Deactivating someone frees no place. |
| The first owner | Creation is exempt. |
| An invited person's arrival | Activates their existing account and consumes no extra place, in either sign-in mode. |

Example refusal:

```json title="Output"
{"error":{"code":"instance_limit_reached","message":"This instance holds its limit of 20 maps. Delete one, or raise the limit. An admin can change \"Maps on this instance\".","key":"mapsLimit","limit":20,"count":20}}
```

Read `instanceLimits` through `GET /api/config` or, for admins, `GET /api/instance/settings`:

| Field inside `instanceLimits` | What it holds |
|---|---|
| `maps`, `projects`, `people` | Each holds `key`, the setting's key; `limit`, with zero meaning unbounded; and `count`, the current instance-wide count. Names and private items are not disclosed. |
| `instanceLimits.tokenLifetimeMax` | `none`, `30d`, `90d` or `1y`. See [Token lifetimes](../self-host/configuration/rules.md#token-lifetimes). |

## Request bodies

Every operation that takes a JSON body has a byte limit, and the [API reference](https://dezfil.io/docs/api/reference/) shows each one. An agent reads it from the API description as `x-byte-limit`:

::::tabs
:::tab[curl]
```sh title="Terminal"
curl -s http://localhost:3000/api/openapi.json \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  | jq '.paths["/api/query"].post.requestBody["x-byte-limit"]'
```
:::
:::tab[JavaScript]
```js title="body-limit.mjs"
const response = await fetch("http://localhost:3000/api/openapi.json", {
  headers: { Authorization: "Bearer <YOUR_TOKEN>" },
});
const description = await response.json();
console.log(description.paths["/api/query"].post.requestBody["x-byte-limit"]);
```

Run it with `node body-limit.mjs`.
:::
::::

```text title="Output"
16777216
```

| What | Limit | At the limit |
|---|---|---|
| A JSON body | The operation's `x-byte-limit` | 413 and the code its `x-byte-error` names: `request_body_too_large`, or `assistant_submission_too_large` for an assistant message |
| Any body but a file upload, until all of it arrives | 300 seconds | 408 `request_timeout` |

Dezfil counts a body's bytes as they arrive, whitespace and escaping included, and refuses a larger body before it parses it. Nothing changes.

A file upload, `POST /api/tables`, has no byte limit in the description: **Largest upload** holds it.

## Rate limits

Dezfil counts requests in three places: visitors reading published maps, sign-ins, and current-password checks. Other requests, with a token or a session, have no rate limit.

| Who | Limit | At the limit |
|---|---|---|
| A visitor reading a published map: its data, widgets and renders | **Requests per visitor**, every 10 seconds | 429 `rate_limited` |
| A visitor's map tiles | **Tile requests per visitor**, every 10 seconds | 429 `rate_limited` |
| Failed sign-ins for one account, and from one address | **Failed sign-ins before a pause**, within 15 minutes | 429 `rate_limited`, with `Retry-After` |
| Wrong current passwords when you change your password or email | The count per account, kept apart from sign-ins | 429 `rate_limited`, with `Retry-After` |
| Sign-ins and password checks working at once | Two run at a time. Six sign-ins may wait, and two current-password checks or sign-in links, which run one at a time; each waits up to 5 seconds. | 503 `authentication_busy`, with `Retry-After: 1` |

The visitor limits are in **Settings** › **Limits**, on the **Public requests** card. The sign-in counts are in **Settings** › **Security**, on the **Sign-in** card, and in [Security and rules](../self-host/configuration/rules.md) with their defaults.

Each visitor is counted by network address, and an IPv6 address with its whole /64. Behind a proxy that `DEZFIL_TRUSTED_PROXIES` does not list, every visitor shares the proxy's count: see [Trusted proxies](../self-host/reverse-proxy.md#trusted-proxies).

A sign-in refusal gives the wait in its answer, as [Errors](errors.md#what-an-error-answer-holds) shows. A visitor's count starts again after its 10 seconds.

An OpenStreetMap import answers `rate_limited` too when the Overpass server refuses it. To avoid the public server's limits, point **Address** on the **OpenStreetMap** card in **Settings** › **Data & services**, or `DEZFIL_OVERPASS_URL`, at your own Overpass server.

## Troubleshooting

### An upload answers 413 with a web page instead of JSON

A reverse proxy refused the upload before it reached Dezfil. Raise the proxy's body limit as [Reverse proxy and HTTPS](../self-host/reverse-proxy.md#uploads-over-1-mb-fail-behind-nginx) shows.

### A row in Settings › Limits has a lock

The server decides it, and the line under the row names the variable that changes it. Change the variable and restart, as [Configuration](../self-host/configuration.md) shows.

### Settings refuses a new Query time limit

**Query time limit** must stay below **Time limit per tool run**. Raise the tool run's limit first, then the query's.

### A geocode or travel-time run is refused as too large

The dataset has more rows than one run takes. Filter it first, or raise **Time limit per tool run**; **Geocode addresses** and **Travel-time area** show the new number.

## Next steps

- [Errors](errors.md): the parts of an error answer, and what to do about each common code.
- [Configuration](../self-host/configuration.md): set a variable, and see which value wins.
- [How the API works](http-api.md): sign-in, edit revisions and paging.
