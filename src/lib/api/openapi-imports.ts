import { FILING_DESTINATION } from "./openapi-project-access";
import { datasetAccess } from "./openapi-dataset-access";
import { ownedCreationOp } from "./openapi-owned-creation";
import { REMOTE_ADD, REMOTE_READ } from "./operation-mcp";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { op, jsonOk, ERROR_RESPONSE } from "./openapi-helpers";

export const IMPORT_PATHS = {
  "/api/imports/url": {
    post: ownedCreationOp(datasetAccess({
      summary: "Import a remote file as one or more tables",
      description:
        "Reads a remote Parquet, CSV, GeoJSON, Shapefile-zip, " +
        "GeoPackage, or KML/KMZ file — https://, s3://, gs://, or " +
        "az:// — and materializes it as GeoParquet tables (a snapshot, " +
        "not a live link; one table per spatial layer for container " +
        "formats). Private buckets use credentials configured in the " +
        "server environment. The URL is stored as the " +
        "tables' provenance, so the import can be re-run with the " +
        "refresh operation.",
      tag: "Tables",
      tool: "import_table_from_url", mcp: REMOTE_ADD,
      display: {"verb": "Imported a file from a URL"},
      effects: writes(resource("tables", "", ["id", "tables.*.id"]), resource("projects")),
      requestBody: {
            "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  description:
                    "Remote file URL (https/http/s3/gs/az) ending in a " +
                    "supported extension.",
                },
                name: {
                  type: "string",
                  description:
                    "Optional table name; derived from the URL when omitted.",
                },
                projectId: {
                  type: ["string", "null"],
                  description:
                    "The project every created table joins" +
                    "; omitted or null, unfiled. An unknown " +
                    "project refuses before the source is contacted." + FILING_DESTINATION,
                },
              },
              required: ["url"],
            },
          },
        },
      },
      responses: {
        "201": jsonOk("#/components/schemas/ImportResult", "Created."),
      },
    })),
  },
  "/api/imports/overture": {
    post: ownedCreationOp(datasetAccess({
      summary: "Import Overture Maps data as a table",
      description:
        "Reads one Overture theme (places, buildings, transportation, " +
        "divisions, base, addresses) for a scope straight from the " +
        "public S3 release and materializes it as a GeoParquet table. " +
        "The scope is a named area (country, state, or a division " +
        "found via the search operation) or a drawn shape (bbox or " +
        "polygon ring). Semantics decide how a drawn or boundary area " +
        'applies: "within" keeps only features entirely inside (the ' +
        "default for most themes), \"intersect\" also keeps " +
        "edge-crossers (default for transportation and base). " +
        "Divisions take a level (an Overture subtype, e.g. region, " +
        "county — discover them via the levels operation) and exclude " +
        "maritime areas. Places accept a category filter. The full " +
        "set of import parameters is stored as provenance for refresh. " +
        "Example: all " +
        'states of Germany = {theme: "divisions", level: "region", ' +
        'scope: {type: "country", code: "DE"}}.',
      tag: "Tables",
      tool: "import_table_from_overture", mcp: REMOTE_ADD,
      display: {"verb": "Imported Overture data as {subject}", "subject": {"resource": "tables", "result": "id", "name": ["name"]}},
      effects: writes(resource("tables", "", "id"), resource("projects")),
      requestBody: {
            "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                theme: {
                  type: "string",
                  enum: [
                    "places",
                    "buildings",
                    "transportation",
                    "divisions",
                    "base",
                    "addresses",
                  ],
                },
                scope: { $ref: "#/components/schemas/OvertureScope" },
                semantics: {
                  type: "string",
                  enum: ["within", "intersect"],
                  description:
                    "How the area applies; defaulted per theme when " +
                    "omitted.",
                },
                level: {
                  type: "string",
                  description:
                    "Divisions only: the subtype to import (e.g. " +
                    "region, county, locality).",
                },
                bbox: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 4,
                  maxItems: 4,
                  description:
                    "[west, south, east, north], WGS84 — legacy " +
                    "alternative to scope; imports as an intersect " +
                    "rectangle.",
                },
                release: {
                  type: "string",
                  description:
                    "Overture release (e.g. 2026-06-17.0); newest known " +
                    "when omitted.",
                },
                category: {
                  type: "string",
                  description: "Places-only category filter.",
                },
                name: {
                  type: "string",
                  description: "Optional table name.",
                },
                projectId: {
                  type: ["string", "null"],
                  description:
                    "The project every created table joins" +
                    "; omitted or null, unfiled. An unknown " +
                    "project refuses before the source is contacted." + FILING_DESTINATION,
                },
              },
              required: ["theme"],
            },
          },
        },
      },
      responses: {
        "201": jsonOk("#/components/schemas/Table", "Created."),
      },
    })),
  },
  "/api/imports/overture/count": {
    post: op({
      summary: "Preview an Overture import's row count",
      description:
        "Counts what an import with the same body would land — same " +
        "scope resolution, same filters — and returns the source " +
        "query. Use it to sanity-check a selection before importing. " +
        "With byLevel: true (divisions only) it returns every admin " +
        "level's count under the scope in one call — the level " +
        "picker's numbers — instead of a single count.",
      tag: "Tables",
      tool: "preview_overture_import", mcp: REMOTE_READ,
      display: {"verb": "Previewed an Overture import"},
      effects: READ_ONLY,
      requestBody: {
            "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                theme: { type: "string" },
                scope: { $ref: "#/components/schemas/OvertureScope" },
                semantics: {
                  type: "string",
                  enum: ["within", "intersect"],
                },
                level: { type: "string" },
                byLevel: {
                  type: "boolean",
                  description:
                    "Divisions only: return per-level scoped counts " +
                    "with samples instead of one number.",
                },
                bbox: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 4,
                  maxItems: 4,
                },
                release: { type: "string" },
                category: { type: "string" },
              },
              required: ["theme"],
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "The count and the source query — or, with byLevel, the " +
            "per-level counts (levels with zero matches are absent).",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  count: { type: "integer" },
                  query: { type: "string" },
                  levels: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        subtype: { type: "string" },
                        label: { type: "string" },
                        count: { type: "integer" },
                        samples: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  },
  "/api/imports/overture/preview": {
    post: op({
      summary: "Run an Overture query and return its features",
      description:
        "Runs exactly the query an import with the same body would " +
        "run and returns the matching features as GeoJSON — capped " +
        "by the render cap with truncation stated — so a selection " +
        "can be inspected on a map before importing (the dialog's " +
        "Run Query button). The answer, envelope included, is bounded " +
        "by Bytes drawn per layer (renderCapBytes), counted as it is " +
        "built; above it the preview answers 422 render_bytes_exceeded " +
        "with no partial result. The import is not held to that limit.",
      tag: "Tables",
      tool: "run_overture_query", mcp: REMOTE_READ,
      display: {"verb": "Ran an Overture query"},
      effects: READ_ONLY,
      requestBody: {
            "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                theme: { type: "string" },
                scope: { $ref: "#/components/schemas/OvertureScope" },
                semantics: {
                  type: "string",
                  enum: ["within", "intersect"],
                },
                level: { type: "string" },
                release: { type: "string" },
                category: { type: "string" },
              },
              required: ["theme"],
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The matching features, capped.",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/FeaturePreview",
              },
            },
          },
        },
        "422": ERROR_RESPONSE,
      },
    }),
  },
  "/api/imports/overture/divisions/countries": {
    get: op({
      summary: "List countries in Overture divisions",
      description:
        "Countries present in a release's division data, by ISO code — " +
        "the roots of the scope picker.",
      tag: "Tables",
      tool: "list_overture_countries", mcp: REMOTE_READ,
      display: {"verb": "Listed Overture countries"},
      effects: READ_ONLY,
      parameters: [
        {
          name: "release",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Release; newest known when omitted.",
        },
      ],
      responses: {
        "200": {
          description: "Countries.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  release: { type: "string" },
                  countries: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        name: { type: "string" },
                        bbox: {
                          type: "array",
                          items: { type: "number" },
                          minItems: 4,
                          maxItems: 4,
                          description:
                            "[west, south, east, north] extent.",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  },
  "/api/imports/overture/divisions/levels": {
    get: op({
      summary: "List a country's division levels",
      description:
        "The admin levels that actually exist in a country's division " +
        "data, with counts and sample names — Overture's vocabulary " +
        "lands differently per country (German municipalities are one " +
        "subtype, French communes another), so levels are discovered, " +
        "never assumed.",
      tag: "Tables",
      tool: "list_overture_division_levels", mcp: REMOTE_READ,
      display: {"verb": "Listed Overture division levels"},
      effects: READ_ONLY,
      parameters: [
        {
          name: "country",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Two-letter ISO country code.",
        },
        {
          name: "release",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Release; newest known when omitted.",
        },
      ],
      responses: {
        "200": {
          description: "Levels, coarse to fine.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  release: { type: "string" },
                  country: { type: "string" },
                  levels: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        subtype: { type: "string" },
                        label: { type: "string" },
                        count: { type: "integer" },
                        samples: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  },
  "/api/imports/overture/divisions/states": {
    get: op({
      summary: "List a country's states",
      description:
        "The country's state/region divisions with ISO 3166-2 codes — " +
        'each is a scope: {type: "state", code}. Empty when the ' +
        "country has no region level.",
      tag: "Tables",
      tool: "list_overture_states", mcp: REMOTE_READ,
      display: {"verb": "Listed Overture states"},
      effects: READ_ONLY,
      parameters: [
        {
          name: "country",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Two-letter ISO country code.",
        },
        {
          name: "release",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Release; newest known when omitted.",
        },
      ],
      responses: {
        "200": {
          description: "States, alphabetical.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  release: { type: "string" },
                  states: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        name: { type: "string" },
                        bbox: {
                          type: "array",
                          items: { type: "number" },
                          minItems: 4,
                          maxItems: 4,
                          description:
                            "[west, south, east, north] extent.",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  },
  "/api/imports/overture/divisions/search": {
    get: op({
      summary: "Find a division by name",
      description:
        "Name search over a country's divisions (cities, " +
        "municipalities, counties) for the typed city scope — matched " +
        "against the division data itself, never a geocoder. The " +
        "returned id is a scope: {type: \"division\", id}.",
      tag: "Tables",
      tool: "search_overture_divisions", mcp: REMOTE_READ,
      display: {"verb": "Searched Overture divisions"},
      effects: READ_ONLY,
      parameters: [
        {
          name: "country",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Two-letter ISO country code.",
        },
        {
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Name text; prefix matches rank first.",
        },
        {
          name: "release",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Release; newest known when omitted.",
        },
      ],
      responses: {
        "200": {
          description: "Ranked matches.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  release: { type: "string" },
                  matches: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        subtype: { type: "string" },
                        kind: { type: "string" },
                        region: { type: ["string", "null"] },
                        bbox: {
                          type: "array",
                          items: { type: "number" },
                          minItems: 4,
                          maxItems: 4,
                          description:
                            "[west, south, east, north] extent.",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  },
  "/api/imports/osm": {
    post: ownedCreationOp(datasetAccess({
      summary: "Import OpenStreetMap data as tables",
      description:
        "Queries the configured Overpass endpoint and lands " +
        "the result as GeoParquet tables split by geometry class " +
        "(stem_points / stem_lines / stem_polygons, non-empty classes " +
        "only) — one import group with one stored query, refreshed " +
        "together. Provide selectors (tag filters like " +
        '["amenity=restaurant"]) with a bbox, or a raw OverpassQL ' +
        "query (the escape hatch; overpass-turbo's {{bbox}} is " +
        "honoured). Either way the server applies its safety envelope " +
        "(output format, timeout, size). Tags land as one JSON column " +
        "plus promoted plain columns for name and the queried keys. " +
        "Identical queries within the cache window do not re-hit the " +
        "endpoint.",
      tag: "Tables",
      tool: "import_table_from_osm", mcp: REMOTE_ADD,
      display: {"verb": "Imported OpenStreetMap data"},
      effects: writes(resource("tables", "", "tables.*.id"), resource("projects")),
      requestBody: {
            "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                selectors: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    'Tag selectors: "key" or "key=value" entries.',
                },
                ql: {
                  type: "string",
                  description:
                    "Raw OverpassQL (alternative to selectors); the " +
                    "safety envelope replaces any declared settings.",
                },
                bbox: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 4,
                  maxItems: 4,
                  description: "[west, south, east, north], WGS84.",
                },
                ring: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 2,
                    maxItems: 2,
                  },
                  description:
                    "Drawn polygon [[lng, lat], …] (≤ 500 points) — " +
                    "alternative to bbox; becomes an Overpass poly " +
                    "filter.",
                },
                geometry: {
                  type: "object",
                  description:
                    "A GeoJSON Polygon or MultiPolygon (≤ 20,000 " +
                    "vertices) as the area — e.g. a feature from an " +
                    "existing table. Each part becomes an Overpass " +
                    "poly filter; holes apply in the post-fetch " +
                    "within filter. Takes precedence over ring/bbox.",
                },
                semantics: {
                  type: "string",
                  enum: ["within", "intersect"],
                  description:
                    "within keeps only features entirely inside the " +
                    "drawn shape (enforced server-side after geometry " +
                    "assembly — Overpass itself returns intersections); " +
                    "the default is intersect.",
                },
                name: {
                  type: "string",
                  description: "Optional table-name stem.",
                },
                projectId: {
                  type: ["string", "null"],
                  description:
                    "The project every created table joins" +
                    "; omitted or null, unfiled. An unknown " +
                    "project refuses before the source is contacted." + FILING_DESTINATION,
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Created tables, one per non-empty geometry class.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  tables: { $ref: "#/components/schemas/TableList" },
                },
              },
            },
          },
        },
      },
    })),
  },
  "/api/imports/osm/preview": {
    post: op({
      summary: "Run an OSM query and return its features",
      description:
        "Runs exactly the Overpass fetch an import with the same " +
        "body would run — same assembly and within filter — and " +
        "returns the features as GeoJSON, capped by the render cap. " +
        "The response is served from the query cache when possible, " +
        "and a following import reuses it. The answer, envelope " +
        "included, is bounded by Bytes drawn per layer " +
        "(renderCapBytes), counted while the features are assembled; " +
        "above it the preview answers 422 render_bytes_exceeded with no " +
        "partial result. The import is not held to that limit.",
      tag: "Tables",
      tool: "run_osm_query", mcp: REMOTE_READ,
      display: {"verb": "Ran an OpenStreetMap query"},
      effects: READ_ONLY,
      requestBody: {
            "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                selectors: {
                  type: "array",
                  items: { type: "string" },
                },
                ql: { type: "string" },
                bbox: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 4,
                  maxItems: 4,
                },
                ring: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 2,
                    maxItems: 2,
                  },
                },
                geometry: {
                  type: "object",
                  description:
                    "GeoJSON Polygon/MultiPolygon area (≤ 20,000 " +
                    "vertices).",
                },
                semantics: {
                  type: "string",
                  enum: ["within", "intersect"],
                },
                name: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The matching features, capped.",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/FeaturePreview",
              },
            },
          },
        },
        "422": ERROR_RESPONSE,
      },
    }),
  },
  "/api/imports/overture/releases": {
    get: op({
      summary: "List Overture releases",
      description: "Available releases, newest first.",
      tag: "Tables",
      tool: "list_overture_releases", mcp: REMOTE_READ,
      display: {"verb": "Listed Overture releases"},
      effects: READ_ONLY,
      responses: {
        "200": {
          description: "Releases.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  releases: { type: "array", items: { type: "string" } },
                  latest: { type: "string" },
                },
              },
            },
          },
        },
      },
    }),
  },
};

export const IMPORT_SCHEMAS = {
  OvertureScope: {
    type: "object",
    description:
      "Where an Overture import applies. One of: " +
      '{type: "country", code: "DE"} · {type: "state", code: ' +
      '"DE-HE"} · {type: "division", id} (an id from the division ' +
      'search) · {type: "bbox", bbox: [w, s, e, n]} · {type: ' +
      '"polygon", ring: [[lng, lat], …]} (≤ 500 points) · {type: ' +
      '"feature", geometry} (a GeoJSON Polygon/MultiPolygon, ≤ ' +
      "20,000 vertices — e.g. a feature from an existing table). " +
      "Named scopes are exact and view-independent; an optional " +
      "label is kept as provenance.",
    properties: {
      type: {
        type: "string",
        enum: [
          "country",
          "state",
          "division",
          "bbox",
          "polygon",
          "feature",
        ],
      },
      code: {
        type: "string",
        description:
          "country/state: ISO 3166-1 alpha-2 or 3166-2 code.",
      },
      id: {
        type: "string",
        description: "division: the Overture division id.",
      },
      bbox: {
        type: "array",
        items: { type: "number" },
        minItems: 4,
        maxItems: 4,
      },
      ring: {
        type: "array",
        items: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
        },
      },
      geometry: {
        type: "object",
        description:
          "feature: a GeoJSON Polygon or MultiPolygon, parts and " +
          "holes intact.",
      },
      label: {
        type: "string",
        description: "Display name, stored as provenance.",
      },
    },
    required: ["type"],
  },
  FeaturePreview: {
    type: "object",
    description:
      "A Run Query result: the features the matching " +
      "import would land, capped by the render cap and bounded by " +
      "Bytes drawn per layer.",
    properties: {
      geojson: {
        type: "object",
        description: "GeoJSON FeatureCollection.",
      },
      featureCount: { type: "integer" },
      truncated: {
        type: "boolean",
        description: "True when more features matched than the cap.",
      },
      cap: { type: "integer" },
    },
    required: ["geojson", "featureCount", "truncated", "cap"],
  },
};
