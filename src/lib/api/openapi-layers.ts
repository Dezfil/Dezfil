import { DOCUMENT_FACT_PROPERTIES, DOCUMENT_FACT_SCHEMA, editRevisionParam, editRevisionResponses } from "./openapi-document-facts";
import { SQL_QUERY } from "./openapi-sql";
import { CARRY_RULE, WRITTEN_IN_REF } from "./openapi-written-in";
import { resultAccess } from "./openapi-result-access";
import { tileAccess } from "./openapi-tile-access";
import { layerAccess } from "./openapi-layer-access";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { changeGroupParam } from "./openapi-mcp";
import { READ_ONLY, writes, resource, recorded } from "./operation-metadata";
import { op, jsonOk, pathParam } from "./openapi-helpers";

export const LAYER_RESOURCE_PATHS = {
  "/api/maps/{id}/layers": {
    get: op(layerAccess({
      summary: "List a map's layers",
      tag: "Layers",
      tool: "list_layers", mcp: LOCAL_READ,
      display: {"verb": "Listed the layers of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      responses: { "200": jsonOk("#/components/schemas/LayerList") },
    })),
    post: op(layerAccess({
      summary: "Create a layer from a SQL result",
      description:
        "The SQL must return at least one geometry column. The first " +
        "geometry column in select order is the primary geometry used " +
        "for simple rendering; additional geometry columns are allowed. " +
        "A default, publication-ready style is applied when none is provided: " +
        "it takes the instance's defaults for new layers, the next color of " +
        "the color cycle with the geometry's opacity, the line width and the " +
        "point radius (`defaults` in the runtime configuration). A given " +
        "style is kept as given.",
      tag: "Layers",
      tool: "create_layer", mcp: LOCAL_ADD,
      display: {"verb": "Created the layer {subject}", "subject": {"resource": "layers", "result": "id", "name": ["name"]}},
      effects: recorded(writes(resource("layers", "", "id"), resource("maps"))),
      parameters: [pathParam("id", "Map id."), changeGroupParam, editRevisionParam],
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LayerCreate" },
            example: {
              name: "Cities",
              sql: "SELECT name, geometry FROM cities",
            },
          },
        },
      },
      responses: { ...editRevisionResponses, "201": jsonOk("#/components/schemas/Layer", "Created.") },
    })),
  },
  "/api/layers/{id}": {
    get: op(layerAccess({
      summary: "Read a layer",
      tag: "Layers",
      tool: "get_layer", mcp: LOCAL_READ,
      display: {"verb": "Read the layer {subject}", "subject": {"resource": "layers", "argument": "id", "name": ["name"]}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Layer id.")],
      responses: { "200": jsonOk("#/components/schemas/Layer") },
    })),
    patch: op(layerAccess({
      summary: "Update a layer",
      description:
        "Any of name, sql, style, visibility, tooltip or popup fields " +
        "(null = automatic), the published-field list (null " +
        "= derived projection), legend inclusion, viz (points | hexbin " +
        "| grid | heatmap — hexbin/grid aggregate server-side and get " +
        "a fill over their aggregate value automatically), filters " +
        "(applied before aggregation; [] removes them), or legend text " +
        "overrides. Text labels live in the style's `label` member. When " +
        "`sql` is changed, it must return at least one geometry column. " +
        "The first geometry column in select order is the primary geometry " +
        "used for simple rendering; additional geometry columns are allowed.",
      tag: "Layers",
      tool: "update_layer", mcp: LOCAL_REPLACE,
      display: {"verb": "Updated the layer {subject}", "subject": {"resource": "layers", "argument": "id", "name": ["name"]}},
      effects: recorded(writes(resource("layers", "id"))),
      parameters: [pathParam("id", "Layer id."), changeGroupParam, editRevisionParam],
      requestBody: {
        "x-byte-limit": 16_777_216,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LayerUpdate" },
          },
        },
      },
      responses: { ...editRevisionResponses, "200": jsonOk("#/components/schemas/Layer") },
    })),
    delete: op(layerAccess({
      summary: "Delete a layer",
      description:
        "Recorded on the undo timeline — an undo restores the layer " +
        "whole. Removing one's own sketch layer also deletes its sketch " +
        "dataset, wherever the map is; removing a layer that draws " +
        "someone else's sketch leaves their dataset.",
      tag: "Layers",
      tool: "delete_layer", mcp: LOCAL_DELETE,
      display: {"verb": "Deleted the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
      effects: recorded(writes(resource("layers", "id"), resource("maps"), resource("tables"))),
      confirmation: {"target": "Delete {target}?", "consequence": "This removes the layer and its bound widgets. Your own sketch layer also deletes its sketch dataset.", "subject": {"path": "/api/layers/{id}", "argument": "id", "name": "name"}},
      confirm: true,
      parameters: [pathParam("id", "Layer id."), changeGroupParam, editRevisionParam],
      responses: { ...editRevisionResponses, "200": jsonOk("#/components/schemas/EditRevisionResult", "Deleted. The surviving map revision.") },
    })),
  },
  "/api/layers/{id}/duplicate": {
    post: op(layerAccess({
      summary: "Duplicate a layer",
      description:
        "Full copy — SQL, style, viz, filters, tooltip, legend settings — " +
        "with a suffixed name, stacked on top of the map's layer order.",
      tag: "Layers",
      tool: "duplicate_layer", mcp: LOCAL_ADD,
      display: {"verb": "Duplicated a layer as {subject}", "subject": {"resource": "layers", "result": "id", "name": ["name"]}},
      effects: recorded(writes(resource("layers", "", "id"), resource("maps"))),
      parameters: [pathParam("id", "Layer id."), changeGroupParam, editRevisionParam],
      responses: { ...editRevisionResponses, "201": jsonOk("#/components/schemas/Layer", "Created.") },
    })),
  },
  "/api/layers/{id}/extent": {
    post: op(layerAccess({
      summary: "A layer's current data extent",
      description:
        "The bounding box of what the layer currently draws" +
        ": its SQL, its stored filters, and any constraints stated " +
        "in `dims` — the ranges, time windows and category selections a " +
        "canvas enforces after the data is fetched. Answers `kind: " +
        "\"extent\"` with `box` as [west, south, east, north], or " +
        "`kind: \"empty\"` when the constraints leave nothing drawn. " +
        "Empty is a normal outcome of filtering, not a failure. A " +
        "client holding the layer's features whole can compute this " +
        "itself; it exists for the case it cannot — a tiled layer, " +
        "whose features never reach the client entire.",
      tag: "Layers",
      tool: "layer_extent", mcp: LOCAL_READ,
      display: {"verb": "Read the extent of the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Layer id.")],
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                dims: {
                  type: "array",
                  items: { type: "object" },
                  description:
                    "Constraints in force beyond the layer's stored " +
                    "filters, in the canvas's dimension form.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonOk("#/components/schemas/LayerExtent", "The extent."),
      },
    })),
  },
};

export const LAYER_QUERY_PATHS = {
  "/api/layers/{id}/export/{format}": {
    get: op(resultAccess(layerAccess({
      summary: "Download a layer's effective result",
      description:
        "The layer's effective result as a file download: " +
        "its SQL, then its stored filters, then OD/aggregation — " +
        "exactly what the builder renders, so a stored filter is never " +
        "dropped on the way out. Live widget selections and other " +
        "transient view state never enter. The result's first geometry " +
        "column is the feature geometry; every other geometry column " +
        "travels as a WKT value beside it. Runs on the hardened " +
        "read-only instance under the universal query bound — timeout, " +
        "memory budget, and cancellation when the caller departs. The " +
        "response is an attachment named <layer>.<ext>; through the " +
        "agent tool it arrives as a base64 attachment envelope.",
      tag: "Layers",
      tool: "export_layer_data", mcp: LOCAL_READ,
      toolOutput: { binary: { representation: "attachment", nativeImage: false } },
      display: {"verb": "Exported the layer {subject} as {arg.format}", "subject": {"resource": "layers", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [
        pathParam("id", "Layer id."),
        {
          name: "format",
          in: "path",
          required: true,
          schema: {
            type: "string",
            enum: ["geoparquet", "geojson", "csv"],
          },
          description:
            "Download format: geoparquet, geojson, or csv (geometry " +
            "as WKT).",
        },
      ],
      responses: {
        "200": {
          description: "The file, as an attachment.",
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "400": {
          description:
            "Unknown format, invalid SQL, or the bounded lane's coded " +
            "errors.",
        },
      },
    }))),
  },
  "/api/layers/{id}/render": {
    get: op(tileAccess(layerAccess({
      summary: "Render data for a layer",
      description:
        "The layer's effective result — its SQL refined by its filters, " +
        "then aggregated by its viz (hexbin/grid cells expose value and " +
        "count). Under the render cap the response is inline GeoJSON " +
        "(mode: inline). A points-viz result over the cap is served as " +
        "vector tiles instead (mode: tiled): tiles are prepared in the " +
        "background — poll while `tiles.state` is `building`; when " +
        "`ready`, `tiles.url` is a {z}/{x}/{y} template and bounds/zoom " +
        "range describe the archive. The inline answer, envelope " +
        "included, is bounded by Bytes drawn per layer (renderCapBytes), " +
        "counted as it is built; above it the layer answers the errored " +
        "state render_bytes_exceeded. Errored states (deleted table, " +
        "failed build, missing tiler, an aggregation over the cap, an " +
        "answer over the byte limit) are returned as data, not an HTTP " +
        "error.",
      tag: "Layers",
      tool: "render_layer", mcp: LOCAL_READ,
      display: {"verb": "Rendered the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Layer id.")],
      responses: { "200": jsonOk("#/components/schemas/LayerRender") },
    }))),
    post: op(tileAccess(layerAccess({
      summary: "Render a computed layer under ephemeral selections",
      description:
        "The settle lane for widget cross-filtering: " +
        "re-render a hexbin, grid, cluster, or heatmap layer with a " +
        "selection set folded into its query — cells re-bin and " +
        "clusters recount, with zero writes. Selections are " +
        "pre-resolved filters and pass the stored-filter validation; " +
        "other viz types enforce selections client-side and reject " +
        "this call.",
      tag: "Layers",
      tool: false,
      effects: READ_ONLY,
      parameters: [pathParam("id", "Layer id.")],
      requestBody: {
        "x-byte-limit": 16_777_216,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                selections: {
                  type: "array",
                  items: { $ref: "#/components/schemas/LayerFilter" },
                },
              },
            },
          },
        },
      },
      responses: { "200": jsonOk("#/components/schemas/LayerRender") },
    }))),
  },
  "/api/layers/{id}/slider-preview": {
    get: op(layerAccess({
      summary: "Read bounded slider-preview input",
      description:
        "Read-only point input for an editing interaction. Discrete " +
        "filters are applied; range/time filters are left for the " +
        "client so a slider can narrow and widen. The response says " +
        "whether it is exact or a stable bounded subset. It never " +
        "changes the layer or its history and is not published.",
      tag: "Layers",
      tool: false,
      effects: READ_ONLY,
      parameters: [pathParam("id", "Layer id.")],
      responses: {
        "200": jsonOk("#/components/schemas/SliderPreviewData"),
      },
    })),
  },
  "/api/layers/{id}/tiles/{z}/{x}/{y}": {
    get: op(tileAccess(layerAccess({
      summary: "One vector tile of a tiled layer",
      description:
        "Mapbox Vector Tile bytes for the archive built from the layer's " +
        "effective result. Use the URL template from the render " +
        "response (it carries a cache-busting version). A spot the " +
        "archive does not cover returns 204 with no body.",
      tag: "Layers",
      tool: false,
      effects: READ_ONLY,
      parameters: [
        pathParam("id", "Layer id."),
        pathParam("z", "Tile zoom."),
        pathParam("x", "Tile column."),
        pathParam("y", "Tile row."),
      ],
      responses: {
        "200": {
          description: "The tile.",
          content: {
            "application/vnd.mapbox-vector-tile": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "204": { description: "No tile at these coordinates." },
      },
    }))),
  },
  "/api/layers/{id}/fields": {
    get: op(layerAccess({
      summary: "A layer's non-geometry columns",
      description:
        "`styling`: columns of the effective result, for fill and " +
        "tooltip fields (an aggregated layer exposes exactly `value` and " +
        "`count`). `filterable`: columns of the layer's own SQL result — " +
        "what filters apply to.",
      tag: "Layers",
      tool: "list_layer_fields", mcp: LOCAL_READ,
      display: {"verb": "Read the fields of the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Layer id.")],
      responses: { "200": jsonOk("#/components/schemas/LayerFields") },
    })),
  },
  "/api/layers/{id}/fields/{field}": {
    get: op(layerAccess({
      summary: "A field's extent or distinct values",
      description:
        "Seed data for a filter control: min/max and a binned " +
        "distribution for numeric and time fields (time extents as " +
        "ISO-8601 strings), distinct values (bounded, by frequency) for " +
        "text. Computed on the layer's own result — the unfiltered " +
        "extent, so a brush keeps a stable background.",
      tag: "Layers",
      tool: "get_field_stats", mcp: LOCAL_READ,
      display: {"verb": "Read the statistics of {arg.field} on the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [
        pathParam("id", "Layer id."),
        pathParam("field", "Field name from the layer's result."),
      ],
      responses: { "200": jsonOk("#/components/schemas/FieldStats") },
    })),
  },
  "/api/layers/{id}/fill": {
    post: op(layerAccess({
      summary: "Compute a data-driven paint",
      description:
        "Quantile, equal-interval, or natural (Fisher–Jenks, computed " +
        "on a bounded sample) breaks for numeric attributes, distinct " +
        "colors for categorical ones, or a " +
        "`continuous` unclassed ramp: the attribute's domain resolved " +
        "over the effective result with the palette's stops baked in " +
        "(diverging palettes come back centered on the mean; clamp, " +
        "log, and center are then style-level edits on the returned " +
        "paint). Optional palette (curated or saved custom — see " +
        "/api/palettes), class count, and reverse. Classification runs on " +
        "the layer's effective result, so filters are respected and an " +
        "aggregated layer classifies its `value` or `count`. Returns a " +
        "paint to merge into the style — `fill`, or `strokeBy` for a " +
        "data-driven outline — or into the viz fill of an aggregated " +
        "layer.",
      tag: "Layers",
      tool: "compute_fill", mcp: LOCAL_READ,
      display: {"verb": "Computed a {arg.method} fill by {arg.attribute} on the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Layer id.")],
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                attribute: { type: "string" },
                method: {
                  type: "string",
                  enum: [
                    "quantile",
                    "equal",
                    "natural",
                    "categorical",
                    "continuous",
                  ],
                },
                palette: {
                  type: "string",
                  description:
                    "Palette name from the catalogue or a saved custom " +
                    "palette; kind must match the method (numeric " +
                    "methods take sequential, diverging, and custom " +
                    "palettes, categorical takes qualitative).",
                },
                classes: {
                  type: "integer",
                  description: "Class count for numeric ramps (2-12).",
                },
                reversed: { type: "boolean" },
              },
              required: ["attribute", "method"],
            },
            example: { attribute: "population", method: "quantile" },
          },
        },
      },
      responses: { "200": jsonOk("#/components/schemas/FillPaint") },
    })),
  },
  "/api/layers/{id}/scale": {
    post: op(layerAccess({
      summary: "Compute a size scale",
      description:
        "Resolve a numeric attribute's value range over the layer's " +
        "effective result (filters respected) and map it onto an " +
        "output range. Returns a scale to merge into the style — " +
        "`pointRadiusBy` for point radius, `strokeWidthBy` for line " +
        "width, or (with unit 'm') `heightBy` for polygon " +
        "extrusion in meters. The sibling of the paint operation, for " +
        "the size channels.",
      tag: "Layers",
      tool: "compute_scale", mcp: LOCAL_READ,
      display: {"verb": "Computed a size scale by {arg.attribute} on the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Layer id.")],
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                attribute: { type: "string" },
                range: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 2,
                  maxItems: 2,
                  description:
                    "Output values, smallest first — pixels (0-200) " +
                    "by default, meters (0-100000) with unit 'm'.",
                },
                unit: {
                  type: "string",
                  enum: ["px", "m"],
                  description:
                    "Output unit: px for sizes (default), m for the " +
                    "extrusion height channel.",
                },
              },
              required: ["attribute", "range"],
            },
            example: { attribute: "population", range: [4, 28] },
          },
        },
      },
      responses: { "200": jsonOk("#/components/schemas/SizeScale") },
    })),
  },
};

export const LAYER_SCHEMAS = {
  Layer: {
    allOf: [DOCUMENT_FACT_SCHEMA],
    type: "object",
    properties: {
      ...DOCUMENT_FACT_PROPERTIES,
      id: { type: "string" },
      mapId: { type: "string" },
      name: { type: "string" },
      sql: SQL_QUERY,
      style: { $ref: "#/components/schemas/Style" },
      visible: { type: "boolean" },
      tooltip: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "Fields shown in the hover tooltip; null = automatic.",
      },
      popup: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "Fields shown in the click pop-up; null = automatic" +
          ".",
      },
      publishedFields: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "The author's explicit published-field list; " +
          "null = the derived minimal projection (style, label, " +
          "tooltip/pop-up, live-filter, timeline and published-widget " +
          "fields). Published responses carry exactly the effective " +
          "set; fields the published map needs to render are always " +
          "published, whatever this lists.",
      },
      inLegend: {
        type: "boolean",
        description: "Whether the layer contributes to the legend.",
      },
      viz: { $ref: "#/components/schemas/Viz" },
      filters: {
        type: "array",
        items: { $ref: "#/components/schemas/LayerFilter" },
        description:
          "Refinements applied before aggregation; the SQL stays the " +
          "source of truth and [] restores it exactly.",
      },
      legendTitle: {
        type: ["string", "null"],
        description: "Legend title override; null = the layer name.",
      },
      legendLabels: {
        type: ["array", "null"],
        items: { type: ["string", "null"] },
        description:
          "Per-entry legend label overrides; null entries (and null " +
          "itself) keep the automatic labels.",
      },
      legendAttrs: {
        type: ["object", "null"],
        description:
          "Per-channel legend attribute-name overrides, keyed by " +
          "channel (fill, stroke, radius, width). Three states per " +
          "channel: a missing key (and null itself) keeps the " +
          "automatic attribute name, a string overrides it, and a " +
          "null value hides that channel's attribute line" +
          ". An override drops automatically when its channel's " +
          "driving attribute changes.",
      },
      ordinal: { type: "integer" },
    },
  },
  LayerList: {
    type: "array",
    items: { $ref: "#/components/schemas/Layer" },
  },
  LayerCreate: {
    type: "object",
    properties: {
      name: { type: "string" },
      sql: SQL_QUERY,
      style: { $ref: "#/components/schemas/Style" },
      writtenIn: {
        ...WRITTEN_IN_REF,
        description:
          "Where sql was written, when not in this map: the caller's " +
          "console (a dataset's \"Add to a map\" too), another map or a " +
          "workflow. The SQL is carried into this map's SQL home and the " +
          "layer stores the carried text. " + CARRY_RULE + " Omitted, the " +
          "SQL is this map's own, read in its home as every saved layer is.",
      },
    },
    required: ["sql"],
  },
  LayerUpdate: {
    type: "object",
    properties: {
      name: { type: "string" },
      sql: SQL_QUERY,
      style: { $ref: "#/components/schemas/Style" },
      visible: { type: "boolean" },
      tooltip: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: 32,
        description:
          "Fields shown in the hover tooltip (up to 32, each an " +
          "existing result column); null = automatic.",
      },
      popup: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: 32,
        description:
          "Fields shown in the click pop-up (up to 32, " +
          "each an existing result column); null = " +
          "automatic. Independent of tooltip — a tooltip often wants " +
          "one field, a pop-up several.",
      },
      publishedFields: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: 32,
        description:
          "Explicit published-field list (up to 32, each " +
          "an existing result column); null restores " +
          "the derived minimal projection. The functional core — " +
          "fields the published map needs to render, label, filter " +
          "and cross-filter — publishes regardless of this list. A " +
          "publication setting: only the map's owner changes it, and " +
          "anyone else's write that would change it is refused whole " +
          "with forbidden.",
      },
      inLegend: { type: "boolean" },
      viz: { $ref: "#/components/schemas/Viz" },
      filters: {
        type: "array",
        items: { $ref: "#/components/schemas/LayerFilter" },
      },
      legendTitle: { type: ["string", "null"] },
      legendLabels: {
        type: ["array", "null"],
        items: { type: ["string", "null"] },
      },
      legendAttrs: {
        type: ["object", "null"],
        description:
          "Per-channel legend attribute-name overrides (fill, " +
          "stroke, radius, width → short string, or null to hide " +
          "that channel's attribute line); null = all automatic.",
      },
    },
  },
};
