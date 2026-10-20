---
title: "Limits"
summary: "The fixed byte ceilings on SQL answers and previews, and the time, size, memory, rate and queue limits an operator changes."
read_when:
  - "a query or an inspection answers query_result_too_large"
  - "you need to know which reads are bounded and by how much"
  - "you want to raise the largest upload, the query time limit or another limit"
audience:
  - user
  - developer
  - agent
  - operator
checked: none
moved_from:
  - "/docs/reference/sql-limits/"
---

SQL console/SQL previews, dataset inspection, geometry-choice preview and the
PostGIS five-row preview have fixed result limits: **33,554,432 bytes (32 MiB)**
for the complete uncompressed UTF-8 JSON answer and **2,097,152 bytes (2 MiB)**
for one non-geometry column value. Equality is admitted. Quotes, escaping,
nested values, schema, repeated keys and metadata count after existing display
conversions and excerpts. Native geometry, identified by type or registered
provenance before conversion, counts only toward the result ceiling; coordinate
text and JSON remain non-geometry. Exceeding either bound refuses the whole
answer with HTTP 422 `query_result_too_large`, without partial data or details:

> The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.

These ceilings have no setting. Row and engine-memory limits still apply;
a result below both byte ceilings can fail the engine-memory limit during
query execution or result projection, including geometry decoding. Layer
renders, dataset map features, slider and Overture previews and published
views retain their existing limits. A filter's distinct values, categorical
classification, category widgets and value search hold each text value they
return to the 2 MiB value ceiling: the first two refuse with the same 422, a
category widget answers that code as its own error while the others keep
working, and value search names the layer under `refusedLayers` and answers no
rows from it, which the builder's search says in a line under its results. SQL, table and layer file exports still stream complete
results above both ceilings. Dataset inspection shows text values, and the WKT
of its registered geometry column, longer than 512 characters as their first
512 characters and an ellipsis, as geometry-choice preview does. Other values,
nested values, additional geometry columns, the schema, row counts and the
stored data stay whole, and SQL console/SQL previews and the PostGIS preview do
not excerpt, so long text alone no longer refuses an inspection. An inspection that still exceeds a
ceiling, with a nested value over 2 MiB for example, prevents its detail and docked set-geometry
panel from opening. It also blocks tool column pickers, SQL schema inventory
and completion, workflow dataset reads and facts, and automatic layer addition
after a tool run. The tool run can report failure even though the dataset has
already been written. Existing layer rendering, dataset map features, complete
API file exports and owner deletion from Data use separate reads and remain
available. This bounds serialized data on the covered reads,
not native chunks, JavaScript object overhead, heap or RSS.

## Limits an operator changes

An admin changes most of these on the **Limits** tab of **Settings**; the rest are variables alone. [Configuration](../self-host/configuration.md) shows how to set a variable and which value wins.

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
| **Engine memory** | `DEZFIL_QUERY_MEMORY_MB` |  | `2048` MB | Any number above 0 | Memory the engine that runs people's SQL may use, shared by every query. | By variable, after a restart |
| **Trusted engine memory** | `DEZFIL_TRUSTED_MEMORY_MB` |  | `3072` MB | Any number above 0 | Memory the engine that imports and processes data may use; it may spill up to four times this to disk. | By variable, after a restart |
| **Slider preview rows** | `DEZFIL_SLIDER_PREVIEW_ROWS` |  | `50000` rows | Any number above 0 | Source points transferred for interactive slider previews. | By variable, after a restart |
| **Published freshness** | `DEZFIL_PUBLISH_FRESHNESS_S` |  | `30` seconds | Any number above 0 | Cache window for published views. | By variable, after a restart |
| **Tile build time limit** | `DEZFIL_TILE_BUILD_TIMEOUT_S` |  | `600` seconds | Any number above 0 | Time budget for each background tile-build stage. | By variable, after a restart |
| **Image request time limit** | `DEZFIL_EXPORT_REQUEST_TIMEOUT_S` |  | `20` seconds | Any number above 0 | Deadline for each request made by the render page. | By variable, after a restart |
| **Tool attachment size** | `DEZFIL_TOOL_ATTACHMENT_MAX_MB` |  | `32` MB | Any number above 0 | The largest file a tool hands back to the assistant or an agent, such as an exported image. | By variable, after a restart |
| **Run history depth** | `DEZFIL_OPERATION_HISTORY_PER_SUBJECT` |  | `20` runs | Any number above 0, rounded down to a whole number of at least 1 | Runs kept in each run history, such as a workflow step's; its latest success is always kept. | By variable, after a restart |

<!-- settings-limits:end -->
