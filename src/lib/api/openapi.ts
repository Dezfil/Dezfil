import { SKETCH_ROW_COUNT_RESPONSE, QUERY_EXPORT_TICKET, PROJECT_EXPORT_TICKET } from "./openapi-tool-responses";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, LOCAL_TRANSIENT_READ, LOCAL_REPLACE, MAP_LOOK, REMOTE_ADD, REMOTE_READ, REMOTE_REPLACE, WORKFLOW_RUN } from "./operation-mcp";
import { changeGroupParam, HISTORY_PATHS, HISTORY_SCHEMAS, MCP_PATHS } from "./openapi-mcp";
import { TABLE_CATALOGUE_PATHS, TABLE_CATALOGUE_SCHEMAS } from "./openapi-table-catalogue";
import { ASSISTANT_PATHS } from "./openapi-assistant";
import { ASSISTANT_SCHEMAS } from "./openapi-assistant-schemas";
import { MAP_LOOK_SCHEMAS } from "./openapi-map-look";
import { READ_ONLY, writes, resource, planning, recorded } from "./operation-metadata";
import { ERROR_RESPONSE, op, jsonOk, pathParam } from "./openapi-helpers";
import { GEOMETRY_RESOURCE_PATHS, GEOMETRY_REFRESH_DESCRIPTION } from "./openapi-geometry-resource";
import { GEOMETRY_RESOURCE_SCHEMAS } from "./openapi-geometry-schemas";
import { CSV_GEOMETRY_DESCRIPTION, GEOMETRY_EVIDENCE_SCHEMAS } from "./openapi-geometry";
import { CAMERA_BOUNDS } from "@/lib/map-runtime-limits";
import { ERROR_CATALOGUE } from "./error-catalogue";
import { WORKFLOW_JSON_BODY_MAX_BYTES } from "./request-bounds";
import { TOKEN_LENGTH } from "@/lib/publish/token";
import { EXPORT_IMAGE_DEFINITION_SCHEMA } from "@/lib/export/image-definition";

/**
 * The OpenAPI description of Dezfil's API — the single source of truth for
 * the human docs and the parity check (spec: a machine-readable description
 * ships alongside the human docs and never diverges). Every capability the UI
 * uses is here; the parity test fails if any route or UI call is missing.
 *
 * Hand-authored (not generated) so it stays reviewable in one file and can
 * wrap it as MCP tools directly.
 */

const WORKFLOW_JSON_BODY_BOUND =
  `**Request body bound.** At most ${WORKFLOW_JSON_BODY_MAX_BYTES.toLocaleString("en-US")} ` +
  "wire bytes; a larger body is refused with `request_body_too_large` before JSON parsing. " +
  "Ordinary maximum-shape layout documents fit; escape-inflated keys and unbounded note ids can exceed the outer byte bound and are refused by design.\n\n";

/** The listings' project scope: shared by maps, tables and
 * recipes so the three doors say the same thing. */
const PROJECT_SCOPE_PARAM = {
  name: "project",
  in: "query",
  required: false,
  schema: { type: "string" },
  description:
    "Narrow to one project's members by project id, or to the unfiled " +
    'with "none". Omitted, everything answers. An unknown project is ' +
    "not found, never an empty list.",
};

/** A card image's theme: a map whose basemap follows the
 * theme carries one image per theme; every other map keeps one image
 * that answers both. */
const THUMBNAIL_THEME_PARAM = {
  name: "theme",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["light", "dark"] },
  description:
    'The viewer\'s theme, "light" or "dark". Any other value is refused.',
};

/** The per-screen view preferences (the workflows list,
 * the Projects list): one slice per list screen, each holding the view
 * and the screen's own sort. Documented on the update body and on the
 * settings read alike. */
function viewPrefsSchema() {
  const slice = (description: string, sorts: string[]) => ({
    type: "object",
    description,
    properties: {
      view: { type: "string", enum: ["grid", "list"] },
      sort: { type: "string", enum: sorts },
    },
  });
  return {
    type: "object",
    description:
      "Per-screen view preferences; slices merge into what is " +
      "stored, and the read carries every slice written so far.",
    properties: {
      maps: slice("The Maps list.", ["edited", "created", "name"]),
      data: slice("The Data page.", ["updated", "name", "rows", "size"]),
      workflows: slice("The workflows list.", ["edited", "created", "name"]),
      projects: slice("The Projects list.", ["updated", "name", "largest"]),
    },
  };
}

export function buildOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Dezfil API",
      version: "0.1.0",
      description:
        "Upload files, query them with SQL, compose styled map layers, and " +
        "publish read-only shareable views. Every capability the UI offers is " +
        "one of these documented calls; the whole journey can be driven headlessly.",
    },
    tags: [
      { name: "System", description: "Health and configuration." },
      { name: "Tables", description: "Uploaded data as queryable tables." },
      { name: "Query", description: "Read-only SQL against tables." },
      { name: "Maps", description: "Maps group ordered, styled layers." },
      { name: "Layers", description: "A layer is SQL + name + style." },
      { name: "Publish", description: "Read-only shareable views." },
      {
        name: "Sketches",
        description:
          "Drawing as data: a draw session becomes one ordinary " +
          "GeoParquet dataset plus one layer on its map. Features carry a " +
          "stable id and drawn kind; the owning-layer cascade deletes " +
          "layer and dataset together and is deliberately not undoable.",
      },
      {
        name: "Operations",
        description:
          "Spatial and data operations. Each produces a durable dataset " +
          "with recorded provenance; the catalog describes the verbs this " +
          "instance offers.",
      },
      {
        name: "Recipes",
        description:
          "A recipe is a named, ordered list of steps whose dependencies " +
          "point only backwards. It records what each step was made from, " +
          "so when the data underneath changes the answer to 'what is now " +
          "out of date' is a fact rather than a guess. Recipes are " +
          "workspace objects like datasets — not owned by a map.",
      },
      {
        name: "Projects",
        description:
          "An optional named set over maps, workflows and datasets" +
          ". A map or workflow is in at most one project; a dataset " +
          "can be in several. Project workflows are workflow-origin " +
          "recipes; builder-origin recipes cannot be project members. " +
          "Projects organize the workspace: they never " +
          "change what SQL sees, how dataset names collide, or what a " +
          "published view serves. Deleting one dissolves the set and " +
          "deletes nothing.",
      },
      {
        name: "Agents",
        description:
          "Drive Dezfil from AI agents: the documented API surface, " +
          "served as MCP tools, plus the in-product assistant.",
      },
    ],
    paths: {
      ...GEOMETRY_RESOURCE_PATHS,
      "/api/health": {
        get: op({
          summary: "Readiness check",
          description: "Readiness reports whether socket provenance is installed and the data directory is usable.",
          tag: "System",
          tool: "check_health", mcp: LOCAL_READ,
          display: {"verb": "Checked the instance"},
          effects: READ_ONLY,
          responses: {
            "200": jsonOk("#/components/schemas/Health", "Ready."),
            "503": jsonOk("#/components/schemas/HealthUnready", "The ingress preload or storage is unavailable."),
          },
        }),
      },
      "/api/config": {
        get: op({
          summary: "Runtime client configuration",
          tag: "System",
          tool: "get_config", mcp: LOCAL_READ,
          display: {"verb": "Read the instance configuration"},
          effects: READ_ONLY,
          responses: { "200": jsonOk("#/components/schemas/Config") },
        }),
      },
      "/api/basemaps/satellite": {
        get: op({
          summary: "The configured imagery style",
          description:
            "A MapLibre style document wrapping the imagery tile template " +
            "this instance configures, with the provider's credit. No " +
            "imagery ships with the app, so an instance that configures " +
            "none answers 404 and offers no imagery basemap.",
          tag: "System",
          tool: false,
          effects: READ_ONLY,
          responses: {
            "200": {
              description: "The style document.",
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true },
                },
              },
            },
            "404": { description: "No imagery is configured." },
          },
        }),
      },
      "/api/palettes": {
        get: op({
          summary: "List palettes",
          description:
            "The full palette offer: the curated catalogue " +
            "plus every saved custom palette. Either kind's name works as " +
            "`palette` in the fill operation.",
          tag: "System",
          tool: "list_palettes", mcp: LOCAL_READ,
          display: {"verb": "Listed the palettes"},
          relevance: ["builder"],
          effects: READ_ONLY,
          responses: { "200": jsonOk("#/components/schemas/PaletteOffer") },
        }),
        post: op({
          summary: "Save a custom palette",
          description:
            "Save a named gradient of ordered color stops. " +
            "Instance-global: it appears in every map's picker and works " +
            "in continuous and classified fills alike. Returns the saved " +
            "palette with its assigned name.",
          tag: "System",
          tool: "create_palette", mcp: LOCAL_ADD,
          display: {"verb": "Saved the palette {subject}", "subject": {"resource": "palettes", "result": "name", "name": ["name"]}},
          effects: writes(resource("palettes", "", "name")),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    label: { type: "string", maxLength: 60 },
                    stops: {
                      type: "array",
                      minItems: 2,
                      maxItems: 16,
                      items: {
                        type: "object",
                        properties: {
                          color: { type: "string", description: "#rrggbb" },
                          position: {
                            type: "number",
                            minimum: 0,
                            maximum: 1,
                          },
                        },
                        required: ["color", "position"],
                      },
                    },
                  },
                  required: ["label", "stops"],
                },
                example: {
                  label: "Brand",
                  stops: [
                    { color: "#f2f0e4", position: 0 },
                    { color: "#0d7d5c", position: 1 },
                  ],
                },
              },
            },
          },
          responses: {
            "201": jsonOk("#/components/schemas/CustomPalette", "Saved."),
          },
        }),
      },
      "/api/palettes/{name}": {
        delete: op({
          summary: "Delete a custom palette",
          description:
            "Remove a saved custom palette from the picker. " +
            "Styles that used it keep rendering — their colors were baked " +
            "in at classification time. Curated palettes cannot be deleted.",
          tag: "System",
          tool: "delete_palette", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted the palette {subject}", "subject": {"resource": "palettes", "argument": "name"}},
          effects: writes(resource("palettes", "name")),
          confirmation: {"target": "Delete {target}?", "consequence": "This removes the palette from the picker. Existing styled layers keep their colors.", "subject": {"path": "/api/palettes", "argument": "name", "name": "label", "collection": "custom", "identity": "name"}},
          confirm: true,
          parameters: [pathParam("name", "Custom palette name.")],
          responses: {
            "200": {
              description: "Deleted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { deleted: { type: "boolean" } },
                  },
                },
              },
            },
          },
        }),
      },
      "/api/settings": {
        get: op({
          summary: "Workspace settings",
          description:
            "Single-user workspace preferences — the display name shown " +
            "behind the rail avatar, the optional instance " +
            "name shown beside the wordmark and in browser titles (" +
            "null when unnamed), and the Maps/Data screens' view " +
            "mode + sort.",
          tag: "System",
          // Deliberately outside the agent tool set: a UI identity
          // preference, not a map capability.
          tool: false,
          effects: READ_ONLY,
          responses: {
            "200": jsonOk("#/components/schemas/WorkspaceSettings"),
          },
        }),
        patch: op({
          summary: "Update workspace settings",
          tag: "System",
          tool: false,
          effects: writes(resource("settings")),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    displayName: {
                      type: "string",
                      maxLength: 80,
                      description: "The workspace display name.",
                    },
                    instanceName: {
                      type: ["string", "null"],
                      maxLength: 80,
                      description:
                        "The optional instance name. Empty, whitespace or " +
                        "null clears it; the instance is then unnamed.",
                    },
                    viewPrefs: viewPrefsSchema(),
                  },
                },
                example: { displayName: "Ada Lovelace" },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/WorkspaceSettings"),
          },
        }),
      },
      "/api/openapi.json": {
        get: op({
          summary: "This OpenAPI description",
          tag: "System",
          tool: "get_api_description", mcp: LOCAL_READ,
          display: {"verb": "Read the API description"},
          effects: READ_ONLY,
          responses: {
            "200": {
              description: "The machine-readable API description.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        }),
      },
      "/api/tables": {
        get: op({
          summary: "List tables",
          tag: "Tables",
          tool: "list_tables", mcp: LOCAL_READ,
          display: {"verb": "Listed the datasets"},
          relevance: ["builder", "sql", "workflow"],
          effects: READ_ONLY,
          parameters: [PROJECT_SCOPE_PARAM],
          responses: {
            "200": jsonOk("#/components/schemas/TableList"),
          },
        }),
        post: op({
          summary: "Upload a file as one or more tables",
          description:
            "multipart/form-data with exactly one file part, named " +
            "`file` — a request with several file parts, or a file under " +
            "another field name, is refused without importing anything. " +
            "To upload a batch, repeat the request once per file. Accepts " +
            "GeoParquet, GeoJSON, CSV, Shapefile (as .zip), GeoPackage, " +
            "and KML/KMZ. A container holding several spatial layers " +
            "creates one table per layer; the answer enumerates them. " +
            CSV_GEOMETRY_DESCRIPTION,
          tag: "Tables",
          tool: "upload_table", mcp: LOCAL_ADD,
          toolInput: { multipart: { field: "file", filename: "filename", content: "content_base64" } },
          display: {"verb": "Uploaded a file"},
          effects: writes(resource("tables", "", ["id", "tables.*.id"]), resource("projects")),
          parameters: [
            {
              name: "project",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "The project every created table joins — a " +
                "query parameter because the body is the file itself. An " +
                "unknown project refuses before the upload is received.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: { file: { type: "string", format: "binary" } },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            "201": jsonOk("#/components/schemas/ImportResult", "Created."),
          },
        }),
      },
      "/api/imports/url": {
        post: op({
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
                        "project refuses before the source is contacted.",
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
        }),
      },
      "/api/imports/overture": {
        post: op({
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
                        "project refuses before the source is contacted.",
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
        }),
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
            "Run Query button).",
          tag: "Tables",
          tool: "run_overture_query", mcp: REMOTE_READ,
          display: {"verb": "Ran an Overture query"},
          effects: READ_ONLY,
          requestBody: {
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
        post: op({
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
                        "project refuses before the source is contacted.",
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
        }),
      },
      "/api/imports/osm/preview": {
        post: op({
          summary: "Run an OSM query and return its features",
          description:
            "Runs exactly the Overpass fetch an import with the same " +
            "body would run — same assembly and within filter — and " +
            "returns the features as GeoJSON, capped by the render cap. " +
            "The response is served from the query cache when possible, " +
            "and a following import reuses it.",
          tag: "Tables",
          tool: "run_osm_query", mcp: REMOTE_READ,
          display: {"verb": "Ran an OpenStreetMap query"},
          effects: READ_ONLY,
          requestBody: {
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
      "/api/connections/postgis": {
        get: op({
          summary: "List PostGIS connections",
          description:
            "Saved connections — passwords are write-only and never appear " +
            "in any response.",
          tag: "Connections",
          tool: "list_postgis_connections", mcp: LOCAL_READ,
          display: {"verb": "Listed the PostGIS connections"},
          effects: READ_ONLY,
          responses: {
            "200": jsonOk("#/components/schemas/PgConnectionList"),
          },
        }),
        post: op({
          summary: "Create a PostGIS connection",
          description:
            "Tests the connection first and saves only on success — " +
            "nothing broken is ever stored. The password is encrypted at " +
            "rest and never returned.",
          tag: "Connections",
          tool: "create_postgis_connection", mcp: REMOTE_ADD,
          display: {"verb": "Created the connection {subject}", "subject": {"resource": "connections", "result": "id", "name": ["name"]}},
          effects: writes(resource("connections", "", "id")),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    url: {
                      type: "string",
                      writeOnly: true,
                      description:
                        "A Postgres URL or libpq key-value string. It is " +
                        "interpreted once and never stored or returned. " +
                        "SSL mode require maps to SSL required; prefer, disable " +
                        "and allow map to SSL not required (outgoing prefer, which " +
                        "may still negotiate TLS). Verify-ca, verify-full, unknown " +
                        "and conflicting repeated modes are refused before source " +
                        "contact, even with explicit fields. Identical repeats are " +
                        "accepted; empty modes are absent. " +
                        "Absent mode defaults to SSL required on create. " +
                        "Explicit fields override only a valid URL.",
                    },
                    host: { type: "string" },
                    port: { type: "integer", default: 5432 },
                    database: { type: "string" },
                    username: { type: "string" },
                    password: {
                      type: "string",
                      writeOnly: true,
                      description: "Write-only — never echoed back.",
                    },
                    ssl: { type: "boolean", default: true },
                  },
                  required: ["name"],
                },
              },
            },
          },
          responses: {
            "201": jsonOk(
              "#/components/schemas/PgConnection",
              "Created and tested.",
            ),
          },
        }),
      },
      "/api/connections/postgis/{id}": {
        patch: op({
          summary: "Update a PostGIS connection",
          description:
            "Accepts any subset of editable fields. Connectivity changes " +
            "are tested as a merged candidate before storage. A blank or " +
            "omitted password keeps the stored password only when the host " +
            "and port still identify the saved endpoint and the update does " +
            "not turn SSL off. Changing the host or port, or turning SSL off, " +
            "requires an entered password. Credentials and a submitted " +
            "URL are never returned.",
          tag: "Connections",
          tool: "update_postgis_connection", mcp: LOCAL_REPLACE,
          display: {"verb": "Updated the connection {subject}", "subject": {"resource": "connections", "argument": "id", "name": ["name"]}},
          effects: writes(resource("connections", "id")),
          parameters: [pathParam("id", "Connection id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    url: {
                      type: "string",
                      writeOnly: true,
                      description:
                        "A Postgres URL or libpq key-value string. An " +
                        "individually supplied field wins over its valid URL part. " +
                        "SSL mode require maps to SSL required; prefer, disable " +
                        "and allow map to SSL not required (outgoing prefer, which " +
                        "may still negotiate TLS). Verify-ca, verify-full, unknown " +
                        "and conflicting repeated modes are refused before source " +
                        "contact, even with explicit fields. Identical repeats are " +
                        "accepted; empty modes are absent. " +
                        "Absent mode retains the saved SSL setting on edit.",
                    },
                    host: { type: "string" },
                    port: { type: "integer" },
                    database: { type: "string" },
                    username: { type: "string" },
                    password: {
                      type: "string",
                      writeOnly: true,
                      description:
                        "Write-only. Blank or omitted keeps the stored password.",
                    },
                    ssl: {
                      type: "boolean",
                      description:
                        "True requires SSL; false does not require it.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/PgConnection"),
          },
        }),
        delete: op({
          summary: "Delete a PostGIS connection",
          description:
            "Imported snapshots stay intact; their refresh then reports " +
            "the missing connection.",
          tag: "Connections",
          tool: "delete_postgis_connection", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted the connection {subject}", "subject": {"resource": "connections", "argument": "id"}},
          effects: writes(resource("connections", "id")),
          confirmation: {"target": "Delete {target}?", "consequence": "Imported snapshots remain. Their refresh will require a connection.", "subject": {"path": "/api/connections/postgis", "argument": "id", "name": "name", "collection": "", "identity": "id"}},
          confirm: true,
          parameters: [pathParam("id", "Connection id.")],
          responses: { "204": { description: "Deleted." } },
        }),
      },
      "/api/connections/postgis/{id}/test": {
        post: op({
          summary: "Test a PostGIS connection",
          description:
            "Reachability, authentication, and PostGIS presence — each " +
            "failure is specific.",
          tag: "Connections",
          tool: "test_postgis_connection", mcp: REMOTE_REPLACE,
          display: {"verb": "Tested the connection {subject}", "subject": {"resource": "connections", "argument": "id"}},
          effects: writes(resource("connections", "id")),
          parameters: [pathParam("id", "Connection id.")],
          responses: {
            "200": jsonOk("#/components/schemas/PgConnection"),
          },
        }),
      },
      "/api/connections/postgis/{id}/tables": {
        get: op({
          summary: "List relations on a PostGIS connection",
          description:
            "Lists importable tables, views, and materialized views with " +
            "independent PostGIS-extension membership, geometry or geography " +
            "facts, and honest planner-estimate states.",
          tag: "Connections",
          tool: "list_postgis_tables", mcp: REMOTE_READ,
          display: {"verb": "Listed the relations of the connection {subject}", "subject": {"resource": "connections", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Connection id.")],
          responses: {
            "200": {
              description: "The source database's tables.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      tables: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            schema: { type: "string" },
                            table: { type: "string" },
                            kind: {
                              type: "string",
                              enum: ["table", "view", "materialized_view"],
                            },
                            system: {
                              type: "boolean",
                              description:
                                "True only for a relation that belongs to the PostGIS extension.",
                            },
                            geometryColumn: { type: ["string", "null"] },
                            geometryType: { type: ["string", "null"] },
                            srid: { type: ["integer", "null"] },
                            spatialKind: {
                              type: ["string", "null"],
                              enum: ["geometry", "geography", null],
                            },
                            approxRows: {
                              type: ["integer", "null"],
                              minimum: 0,
                              description:
                                "Omitted for a view, null for a never-analyzed table or materialized view, and numeric otherwise. Zero is a known estimate.",
                            },
                          },
                          required: [
                            "schema",
                            "table",
                            "kind",
                            "system",
                            "geometryColumn",
                            "geometryType",
                            "srid",
                            "spatialKind",
                          ],
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
      "/api/connections/postgis/{id}/preview": {
        post: op({
          summary: "Preview a PostGIS relation",
          description:
            "Reads at most five rows from one saved connection and relation. " +
            "The optional WHERE expression passes through the import guard and " +
            "is applied to the preview. The caller cannot supply credentials, " +
            "source SQL, or a row limit. Caller departure prevents later stages " +
            "of this preview and discards late results (empty HTTP 499). Every source " +
            "connection opened by the preview attachment has a 30-second " +
            "per-statement ceiling; timeout answers HTTP 408 query_timeout. " +
            "A departed caller's blocked source statement runs to that ceiling: " +
            "the interrupt is observed between scan chunks and cannot reach a " +
            "scan blocked in a libpq read. The aborted case's 35-second bound " +
            "on responsive source and transport is met by the ceiling and is " +
            "not evidence of interrupt propagation. " +
            "The preview records nothing about the connection: neither its " +
            "success nor any failure, cancellation or timeout changes the " +
            "stored health, which answers for the last connection test, " +
            "import or refresh. Connection tests, catalogue reads, imports " +
            "and refreshes keep their existing limits.",
          tag: "Connections",
          tool: "preview_postgis_relation", mcp: REMOTE_READ,
          display: {"verb": "Previewed a relation of the connection {subject}", "subject": {"resource": "connections", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Connection id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    schema: { type: "string" },
                    table: { type: "string" },
                    filter: {
                      type: "string",
                      description:
                        "Optional WHERE expression evaluated on the source.",
                    },
                  },
                  required: ["schema", "table"],
                },
              },
            },
          },
          responses: {
            "408": { description: "query_timeout: The PostGIS source query took too long." },
            "499": { description: "The caller departed. Empty response." },
            "200": {
              description:
                "The relation columns and up to five filtered source rows. Columns remain present when no row matches.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      columns: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            type: { type: "string" },
                            spatialKind: {
                              type: ["string", "null"],
                              enum: ["geometry", "geography", null],
                            },
                          },
                          required: ["name", "type", "spatialKind"],
                        },
                      },
                      rows: {
                        type: "array",
                        maxItems: 5,
                        items: {
                          type: "object",
                          additionalProperties: true,
                        },
                      },
                    },
                    required: ["columns", "rows"],
                  },
                },
              },
            },
          },
        }),
      },
      "/api/connections/postgis/{id}/snapshots": {
        get: op({
          summary: "List snapshots for a PostGIS connection",
          description:
            "Returns exactly the workspace tables whose stored provenance " +
            "carries this connection id, including refresh and recipe facts.",
          tag: "Connections",
          tool: "list_postgis_snapshots", mcp: LOCAL_READ,
          display: {"verb": "Listed the snapshots of the connection {subject}", "subject": {"resource": "connections", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Connection id.")],
          responses: {
            "200": {
              description: "The connection's workspace snapshots.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      snapshots: { $ref: "#/components/schemas/TableList" },
                    },
                  },
                },
              },
            },
          },
        }),
      },
      "/api/imports/postgis": {
        post: op({
          summary: "Import a PostGIS table as a snapshot",
          description:
            "Materializes the table as a GeoParquet snapshot — read-only " +
            "against the source, geometry normalized to WGS84 on the " +
            "source side. An optional attribute filter and row limit " +
            "narrow the import and become part of the stored import " +
            "parameters, so refresh honours them. Live federation is " +
            "deliberately not offered.",
          tag: "Tables",
          tool: "import_table_from_postgis", mcp: REMOTE_ADD,
          display: {"verb": "Imported a PostGIS table as {subject}", "subject": {"resource": "tables", "result": "id", "name": ["name"]}},
          effects: writes(resource("tables", "", "id"), resource("connections", "connectionId"), resource("projects")),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    connectionId: { type: "string" },
                    schema: { type: "string" },
                    table: { type: "string" },
                    name: { type: "string", description: "Optional table name." },
                    filter: {
                      type: "string",
                      description:
                        "Optional WHERE expression evaluated on the source.",
                    },
                    limit: {
                      type: "integer",
                      description: "Optional row limit.",
                    },
                    projectId: {
                      type: ["string", "null"],
                      description:
                        "The project every created table joins" +
                        "; omitted or null, unfiled. An unknown " +
                        "project refuses before the source is contacted.",
                    },
                  },
                  required: ["connectionId", "schema", "table"],
                },
              },
            },
          },
          responses: {
            "201": jsonOk("#/components/schemas/Table", "Created."),
          },
        }),
      },
      "/api/tables/{name}/refresh": {
        post: op({
          summary: "Refresh an imported table",
          description:
            "Re-runs the table's stored import (URL, Overture, and OSM " +
            "imports) and replaces its data atomically. A failed refresh " +
            "leaves the previous data fully intact. Dependent layers pick " +
            "up the refreshed data on their next render. Overture tables " +
            'accept an optional release ("latest" or a specific one) to ' +
            "move the stored import parameters — an explicit choice, never " +
            "implicit. Refreshing any table of an OSM import group re-runs " +
            "the stored query once (bypassing the cache) and updates every " +
            "table of the group together. Refresh is single-flight per " +
            "table (per group for OSM): while one runs, a second request " +
            "answers 409 refresh_in_flight without starting another build; " +
            "retry when the running refresh completes. A table deleted " +
            "while its refresh runs answers 404 not_found and nothing is " +
            "replaced. " + GEOMETRY_REFRESH_DESCRIPTION,
          tag: "Tables",
          tool: "refresh_table", mcp: REMOTE_REPLACE,
          display: {"verb": "Refreshed the dataset {subject}", "subject": {"resource": "tables", "argument": "name"}},
          effects: writes(resource("tables", "name"), resource("connections")),
          parameters: [pathParam("name", "Table name.")],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    release: {
                      type: "string",
                      description:
                        'Overture only: "latest" or a release like 2026-06-17.0.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/Table", "Refreshed."),
          },
        }),
      },
      "/api/tables/{name}/features": {
        get: op({
          summary: "Read a table's features as GeoJSON",
          description:
            "The table's features as a GeoJSON FeatureCollection, for " +
            "drawing it as a reference layer (the import dialog's map " +
            "legend and Select from Layer use this). A table that cannot " +
            "draw — no geometry column, or more features than the render " +
            "cap — returns ok:false with a plain-language reason instead " +
            "of an error. With sample=1 an over-cap table draws its first " +
            "cap-many features and flags the response as sampled.",
          tag: "Tables",
          tool: "get_table_features", mcp: LOCAL_READ,
          display: {"verb": "Read the features of the dataset {subject}", "subject": {"resource": "tables", "argument": "name"}},
          relevance: ["builder", "sql", "workflow"],
          effects: READ_ONLY,
          parameters: [
            pathParam("name", "Table name."),
            {
              name: "sample",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["1"] },
              description:
                "Draw a capped subset of an over-cap table instead of " +
                "refusing; the response carries sampled + totalCount.",
            },
          ],
          responses: {
            "200": {
              description: "The features, or an honest refusal.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      name: { type: "string" },
                      geometryType: { type: ["string", "null"] },
                      featureCount: { type: "integer" },
                      geojson: {
                        type: "object",
                        description:
                          "FeatureCollection when ok; features carry a " +
                          "stable numeric id.",
                      },
                      sampled: {
                        type: "boolean",
                        description:
                          "True when a capped subset was drawn.",
                      },
                      totalCount: {
                        type: "integer",
                        description:
                          "The table's real row count when sampled.",
                      },
                      reason: {
                        type: "string",
                        description: "Why the table cannot draw, when not ok.",
                      },
                    },
                    required: ["ok", "name"],
                  },
                },
              },
            },
          },
        }),
      },
      "/api/tables/{name}/export": {
        get: op({
          summary: "Download a table",
          description:
            "The table as a file download: geoparquet streams the " +
            "stored artifact byte-for-byte; geojson (spatial tables only) " +
            "and csv (geometry as WKT) are converted on the fly. The " +
            "response is an attachment named <table>.<ext>.",
          tag: "Tables",
          // A binary download for a browser, not an agent capability —
          // agents read data through SQL and the features endpoint.
          tool: false,
          effects: READ_ONLY,
          parameters: [
            pathParam("name", "Table name."),
            {
              name: "format",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["geoparquet", "geojson", "csv"],
                default: "geoparquet",
              },
              description: "Download format; geoparquet when omitted.",
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
                "Unknown format, or GeoJSON asked of a non-spatial table.",
            },
          },
        }),
      },
      "/api/tables/{name}": {
        get: op({
          summary: "Inspect a table",
          description: "Schema, row count, and a row preview.",
          tag: "Tables",
          tool: "inspect_table", mcp: LOCAL_READ,
          display: {"verb": "Inspected the dataset {subject}", "subject": {"resource": "tables", "argument": "name"}},
          relevance: ["builder", "sql", "workflow"],
          effects: writes(resource("tables", "name")),
          parameters: [pathParam("name", "Table name.")],
          responses: {
            "200": jsonOk("#/components/schemas/TableInspection"),
          },
        }),
        delete: op({
          summary: "Delete a table",
          tag: "Tables",
          tool: "delete_table", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted the dataset {subject}", "subject": {"resource": "tables", "argument": "name"}},
          effects: writes(resource("tables", "name"), resource("projects")),
          confirmation: {"target": "Delete {target}?", "consequence": "This deletes the dataset and its data. Layers that read it will lose their source.", "subject": {"path": "/api/catalogue/tables?names={name}", "argument": "name", "name": "name", "collection": "tables", "identity": "name"}},
          confirm: true,
          parameters: [pathParam("name", "Table name.")],
          responses: { "204": { description: "Deleted." } },
        }),
      },
      "/api/operations": {
        get: op({
          summary: "List the operations this instance offers",
          description:
            "The operation catalog, as data: each verb's id, group, the " +
            "input geometry it accepts, and its parameters. Read this to " +
            "discover what may be passed to the run endpoint.",
          tag: "Operations",
          tool: "list_operations", mcp: LOCAL_READ,
          display: {"verb": "Listed the operations"},
          relevance: ["builder", "workflow"],
          effects: READ_ONLY,
          responses: {
            "200": jsonOk("#/components/schemas/OperationCatalog"),
          },
        }),
      },
      "/api/operations/run": {
        post: op({
          summary: "Run an operation",
          description:
            "Accepts one operation and answers **202** with a run, before " +
            "the work is done; poll the run's own resource for its " +
            "outcome. An accepted run outlives the request that started " +
            "it — closing the connection does not stop it, and only an " +
            "explicit cancel or the execution budget ends it early.\n\n" +
            "What is refused here, and what is reported on the run, is a " +
            "fixed line. Refused immediately, minting no run: a malformed " +
            "body, an unknown operation, SQL that is not an accepted " +
            "read-only SELECT, an output name already taken, and a full " +
            "queue. Reported on the run instead: SQL that parses but " +
            "fails to bind or execute, a name taken between acceptance " +
            "and commit, the engine memory budget, the execution budget, " +
            "and a server stopped mid-run.\n\n" +
            "Set dryRun to ask what the operation would produce without " +
            "writing anything; a dry run is synchronous and mints no " +
            "run.\n\n" +
            "**sql_step** keeps the result of a read-only SELECT as a " +
            "dataset — the escape hatch inside any recipe, and the way to " +
            "save a query you already trust. A result with no geometry is " +
            "an ordinary dataset, not a failure.\n\n" +
            "**Measurements are ground metres.** A buffer's radius and a " +
            "measured length are metres on the earth, at the latitude the " +
            "data occupies — never degrees, and never metres on a map " +
            "projection. They are measured in a projection resolved from " +
            "the data's own extent, and the output's provenance records " +
            "which. Data spanning more than one local projection is " +
            "**refused** for a distance with `measurement_crs_unavailable`, " +
            "naming the extent it saw; an **area** over the same data " +
            "succeeds, because every area is measured in a global " +
            "equal-area projection. An input whose coordinate system was " +
            "assumed rather than declared is measured anyway and the answer " +
            "says so, on the dry run, on the accepted run, and on the " +
            "output.",
          tag: "Operations",
          tool: "run_operation", mcp: REMOTE_ADD,
          display: {"verb": "Ran the operation {arg.operation}", "planningVerb": "Planned the operation {arg.operation}"},
          relevance: ["builder", "workflow"],
          effects: planning("dryRun", writes(resource("runs", "", "run.id"), resource("tables"))),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    operation: {
                      type: "string",
                      description: "An operation id from the catalog.",
                    },
                    parameters: {
                      type: "object",
                      description:
                        "The operation's own parameters, as the catalog " +
                        "describes them.",
                    },
                    subject: {
                      type: "string",
                      description:
                        "Groups this run with others in history, so " +
                        "'when did this last succeed' has an answer " +
                        "across re-runs. Omitted, the run is its own " +
                        "subject.",
                    },
                    dryRun: {
                      type: "boolean",
                      description:
                        "Report what the run would produce and write nothing.",
                    },
                  },
                  required: ["operation", "parameters"],
                },
                example: {
                  operation: "sql_step",
                  parameters: {
                    sql: "SELECT borough, count(*) AS n FROM accidents GROUP BY borough",
                    name: "accidents_by_borough",
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonOk(
              "#/components/schemas/OperationDryRun",
              "What the run would produce; nothing written.",
            ),
            "202": jsonOk(
              "#/components/schemas/OperationRunEnvelope",
              "Accepted; poll the run for its outcome.",
            ),
          },
        }),
      },
      "/api/operations/runs": {
        get: op({
          summary: "List operation runs",
          description:
            "Run history, newest first. Narrow to one subject to answer " +
            "'when did this last succeed' — a failed run never erases the " +
            "successful one before it, so both are kept. History is " +
            "bounded per subject, and a subject's most recent success is " +
            "preserved even when the depth would otherwise drop it.",
          tag: "Operations",
          tool: "list_operation_runs", mcp: LOCAL_READ,
          display: {"verb": "Listed the operation runs"},
          relevance: ["workflow"],
          effects: READ_ONLY,
          parameters: [
            {
              name: "subject",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Only runs sharing this subject identity.",
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer" },
              description: "Most runs to return; newest first.",
            },
          ],
          responses: {
            "200": jsonOk("#/components/schemas/OperationRunList"),
          },
        }),
      },
      "/api/operations/runs/{id}": {
        get: op({
          summary: "Read an operation run",
          description:
            "What a caller polls after the run endpoint accepted their " +
            "operation. A succeeded run names its output dataset; a " +
            "failed one carries a coded error. There is no completion " +
            "percentage: a run reports when it started, and elapsed time " +
            "follows from that.",
          tag: "Operations",
          tool: "get_operation_run", mcp: LOCAL_READ,
          display: {"verb": "Read the operation run {subject}", "subject": {"resource": "runs", "argument": "id"}},
          relevance: ["workflow"],
          effects: READ_ONLY,
          parameters: [pathParam("id", "Run id.")],
          responses: {
            "200": jsonOk("#/components/schemas/OperationRunEnvelope"),
          },
        }),
      },
      "/api/operations/runs/{id}/cancel": {
        post: op({
          summary: "Cancel an operation run",
          description:
            "Stops a run for real: a queued one never starts, and a " +
            "running one is interrupted in the engine rather than only " +
            "in the record. A cancelled run leaves no dataset and no " +
            "stranded file behind. Cancelling a run that has already " +
            "finished is not an error — it answers the run unchanged, " +
            "because 'make sure this is not running' is already true.",
          tag: "Operations",
          tool: "cancel_operation_run", mcp: LOCAL_REPLACE,
          display: {"verb": "Cancelled the operation run {subject}", "subject": {"resource": "runs", "argument": "id"}},
          relevance: ["workflow"],
          effects: writes(resource("runs", "id")),
          parameters: [pathParam("id", "Run id.")],
          responses: {
            "200": jsonOk("#/components/schemas/OperationRunEnvelope"),
          },
        }),
      },
      "/api/recipes": {
        get: op({
          summary: "List recipes",
          description:
            "Every recipe in the workspace, each with its steps and their " +
            "current conditions, what each step reads now, and a summary " +
            "of the whole (its status and counts). A recipe is a workspace " +
            "object like a dataset — not owned by a map, and outliving the " +
            "layer that prompted it. `origin` narrows the answer to the " +
            "workflows page's own (`workflow`) or the builder's one-step " +
            "recipes (`builder`); unfiltered, both answer.",
          tag: "Recipes",
          tool: "list_recipes", mcp: LOCAL_READ,
          display: {"verb": "Listed the workflows"},
          effects: READ_ONLY,
          parameters: [
            {
              name: "origin",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["workflow", "builder"] },
              description:
                "Which surface made the recipes wanted. Omitted, every recipe.",
            },
            PROJECT_SCOPE_PARAM,
          ],
          responses: { "200": jsonOk("#/components/schemas/RecipeList") },
        }),
        post: op({
          summary: "Create a recipe",
          description:
            WORKFLOW_JSON_BODY_BOUND +
            "A named, ordered list of steps. Dependencies may point only " +
            "backwards, which is what keeps it authorable as a list and " +
            "checkable without cycle detection at run time. The name is " +
            "trimmed, must not be empty, and is at most 120 characters; two " +
            "recipes may share one. `origin` says which surface is creating " +
            "it — `workflow` (the default) or `builder`, the one-step Tools' " +
            "invisible recipes — and never changes afterwards. Only " +
            "workflows can be project members.",
          tag: "Recipes",
          tool: "create_recipe", mcp: LOCAL_ADD,
          display: {"verb": "Created the workflow {subject}", "subject": {"resource": "recipes", "result": "recipe.id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "", "recipe.id"), resource("projects")),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", maxLength: 120 },
                    origin: { type: "string", enum: ["workflow", "builder"] },
                    projectId: {
                      type: ["string", "null"],
                      description:
                        "The project the new workflow joins; " +
                        "omitted or null, it starts unfiled. An unknown " +
                        "project refuses and creates nothing. Builder-origin " +
                        "recipes are refused project membership.",
                    },
                  },
                  required: ["name"],
                },
                example: { name: "Accidents near schools" },
              },
            },
          },
          responses: {
            "201": jsonOk("#/components/schemas/RecipeEnvelope", "Created."),
          },
        }),
      },
      "/api/recipes/{id}": {
        get: op({
          summary: "Read a recipe",
          description:
            "The recipe and every step in order, each with **all** the " +
            "conditions true of it — broken, output missing, stale, never " +
            "run, current — its stale causes with the input each came from, " +
            "and its latest attempt as an ordinary run. The condition and " +
            "the attempt are read together: fresh output with a failed " +
            "latest attempt is a real and common combination.",
          tag: "Recipes",
          tool: "get_recipe", mcp: LOCAL_READ,
          display: {"verb": "Read the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Recipe id.")],
          responses: { "200": jsonOk("#/components/schemas/RecipeEnvelope") },
        }),
        patch: op({
          summary: "Rename a recipe",
          description:
            WORKFLOW_JSON_BODY_BOUND +
            "The same name rule as creation: trimmed, not empty, at most 120 " +
            "characters, shared names allowed. Renaming moves the recipe's " +
            "last-edited time, as adding, editing, reordering or removing a " +
            "step does; running it does not.",
          tag: "Recipes",
          tool: "update_recipe", mcp: LOCAL_REPLACE,
          display: {"verb": "Updated the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "id")),
          parameters: [pathParam("id", "Recipe id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/RecipeEnvelope") },
        }),
        delete: op({
          summary: "Delete a recipe",
          description:
            "**The datasets its steps produced remain in the workspace.** A " +
            "recipe records how they were made; it does not own them. That " +
            "is what this confirmation is for — a user expecting the tables " +
            "to go with it has been told the wrong thing.",
          tag: "Recipes",
          tool: "delete_recipe", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
          effects: writes(resource("recipes", "id"), resource("projects")),
          confirmation: {"target": "Delete {target}?", "consequence": "This deletes the workflow. Its output datasets remain in the workspace.", "subject": {"path": "/api/recipes/{id}", "argument": "id", "name": "recipe.name"}},
          confirm: true,
          parameters: [pathParam("id", "Recipe id.")],
          responses: {
            "200": jsonOk("#/components/schemas/RecipeDeleted"),
          },
        }),
      },
      "/api/recipes/{id}/duplicate": {
        post: op({
          summary: "Duplicate a recipe",
          description:
            "A copy named \"<name> copy\", a workflow, that has never run: " +
            "the same steps in the same order under fresh ids, each from its " +
            "active definition (a pending edit is not carried) with its " +
            "layer provenance; every output renamed to a free name; every " +
            "read of an original output redirected to the copy's, in named " +
            "inputs and in SQL table references alike, with literals and " +
            "comments untouched. The original and its datasets are unchanged. " +
            "Refused (409) if the recipe changes while the copy is prepared, " +
            "and (422) if a step's SQL cannot be rewritten to read the copy's " +
            "outputs.",
          tag: "Recipes",
          tool: "duplicate_recipe", mcp: LOCAL_ADD,
          display: {"verb": "Duplicated a workflow as {subject}", "subject": {"resource": "recipes", "result": "recipe.id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "", "recipe.id"), resource("projects")),
          parameters: [pathParam("id", "Recipe id.")],
          responses: {
            "201": jsonOk("#/components/schemas/RecipeEnvelope", "Created."),
          },
        }),
      },
      "/api/recipes/{id}/dependencies": {
        get: op({
          summary: "The datasets a workflow reads and writes",
          description:
            "The filing checklist's subject for a workflow: " +
            "every registered dataset the workflow's current node " +
            "definitions read (a pending edit over the active one) and " +
            "every current registered output of the workflow, exactly " +
            "once — a dataset both read and written appears once — with " +
            "the same facts as a map's dependencies: source, row count, " +
            "project memberships, the producing workflow, geometry column " +
            "and sampled geometry type. A node whose definition cannot be " +
            "analyzed fails the whole read with `dependencies_unresolved`; " +
            "unlike the recipe read, which tolerates an unreadable node, " +
            "this read never answers partially.",
          tag: "Recipes",
          tool: "get_workflow_dependencies", mcp: LOCAL_READ,
          display: {"verb": "Read the datasets of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Recipe id.")],
          responses: {
            "200": jsonOk("#/components/schemas/WorkflowDependencies"),
          },
        }),
      },
      "/api/recipes/{id}/layout": {
        get: op({
          summary: "Read a recipe's canvas layout",
          description:
            "The layout document: where each step and each " +
            "source sits on the canvas, and the notes written around them. " +
            "Stored beside the recipe, never inside it: nothing here changes " +
            "what a run does or what a step reads. A recipe never arranged " +
            "reads as the empty document with no write time. A read never " +
            "names a step the recipe no longer has.",
          tag: "Recipes",
          tool: "get_recipe_layout", mcp: LOCAL_READ,
          display: {"verb": "Read the layout of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Recipe id.")],
          responses: { "200": jsonOk("#/components/schemas/RecipeLayoutEnvelope") },
        }),
        put: op({
          summary: "Replace a recipe's canvas layout",
          description:
            WORKFLOW_JSON_BODY_BOUND +
            "Replaces the whole document and answers with it as stored; " +
            "there is no partial update, and `{}` is the empty document. A " +
            "position for a step id the recipe does not have is dropped, " +
            "not refused. Anything else wrong (a position that is not two " +
            "finite numbers, more than 1,000 step positions, more than 1,000 " +
            "source positions, a step or source key past 1,000 characters, " +
            "a note missing a field, a colour outside the six, text past " +
            "4,000 characters, a non-positive size, a blank or duplicated " +
            "note id, more than 100 notes) is refused whole (400) naming " +
            "the first fault, and nothing is stored. A write that changes " +
            "the document moves the recipe's last-edited time; one that " +
            "stores what was already stored does not. Last write wins.",
          tag: "Recipes",
          tool: "set_recipe_layout", mcp: LOCAL_REPLACE,
          display: {"verb": "Arranged the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
          effects: writes(resource("recipes", "id")),
          parameters: [pathParam("id", "Recipe id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RecipeLayoutInput" },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/RecipeLayoutEnvelope") },
        }),
      },
      "/api/recipes/{id}/steps": {
        post: op({
          summary: "Add a step",
          description:
            WORKFLOW_JSON_BODY_BOUND +
            "Appends a step naming an operation from the catalog, its " +
            "parameters, and the dataset it will produce.\n\n" +
            "**The output's name**: stored in the registry's " +
            "form; a blank or letterless name is refused in its own words; " +
            "a name a registered table carries, or another step of this " +
            "recipe declares or holds, is refused (`name_taken`) naming the " +
            "holder. Another recipe's unrun declaration is no reservation. " +
            "A step may be added unnamed; the run refuses a nameless one. " +
            "**SQL the parser cannot read is accepted** with no present " +
            "reads; the dry run and the run refuse it and say why.\n\n" +
            "Give `fromLayerId` to author it from a layer: the step takes " +
            "that layer's SQL **refined by its filters**, captured now and " +
            "never re-read, so the step stays reproducible when the filters " +
            "later change. Where the layer is drawn as hex bins, grid cells " +
            "or origin–destination lines, the step consumes the **rows " +
            "behind** those cells rather than the cells themselves, and the " +
            "answer says so in `origin.substitutionNote`.\n\n" +
            "A step that would read its own output, or a later step's, is " +
            "refused here rather than at run time.",
          tag: "Recipes",
          tool: "add_recipe_step", mcp: LOCAL_ADD,
          display: {"verb": "Added a step to the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "id")),
          parameters: [pathParam("id", "Recipe id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    operation: {
                      type: "string",
                      description: "An operation id from the catalog.",
                    },
                    parameters: {
                      type: "object",
                      description:
                        "The operation's own parameters, as the catalog " +
                        "describes them — including non-scalar ones, which " +
                        "are kept as sent.",
                    },
                    fromLayerId: {
                      type: "string",
                      description:
                        "Author from this layer: its filtered SQL is " +
                        "captured into the step's `sql` parameter.",
                    },
                  },
                  required: ["operation"],
                },
                example: {
                  operation: "spatial_join",
                  parameters: {
                    left: "boroughs",
                    right: "accidents",
                    predicate: "contains",
                    carry: [{ aggregate: "count" }],
                    name: "boroughs_with_accidents",
                  },
                },
              },
            },
          },
          responses: {
            "201": jsonOk("#/components/schemas/RecipeStepEnvelope", "Created."),
          },
        }),
      },
      "/api/recipes/{id}/steps/{stepId}": {
        get: op({
          summary: "Read a step",
          description:
            "One step's definition, condition, stale causes, recorded " +
            "inputs and latest attempt.",
          tag: "Recipes",
          tool: "get_recipe_step", mcp: LOCAL_READ,
          display: {"verb": "Read a step of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [
            pathParam("id", "Recipe id."),
            pathParam("stepId", "Step id."),
          ],
          responses: {
            "200": jsonOk("#/components/schemas/RecipeStepEnvelope"),
          },
        }),
        patch: op({
          summary: "Edit a step",
          description:
            WORKFLOW_JSON_BODY_BOUND +
            "**A change to a step that has already produced something is a " +
            "proposal.** The step keeps meaning what its output was produced " +
            "from until a run of the proposal succeeds; `applied` says which " +
            "of the two happened — `active` for a step that had produced " +
            "nothing, `proposed` otherwise. An edit that puts the active " +
            "definition back clears the pending one and answers `active`" +
            ".\n\n" +
            "**Reading a later step's output orders the recipe rather than " +
            "refusing**: the reader and everything depending on it move after " +
            "the producer, other steps keep their places, the whole order is " +
            "checked, and the edit and the order land together or not at " +
            "all; a self-read is refused. **A produced output's name is " +
            "frozen**; before the first run the name rule of adding applies. " +
            "**SQL the parser cannot read is accepted** with no present " +
            "reads. Refused (409) if the recipe changed while the edit was " +
            "checked.",
          tag: "Recipes",
          tool: "update_recipe_step", mcp: LOCAL_REPLACE,
          display: {"verb": "Edited a step of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "id")),
          parameters: [
            pathParam("id", "Recipe id."),
            pathParam("stepId", "Step id."),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    parameters: { type: "object" },
                    fromLayerId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/RecipeStepEdited"),
          },
        }),
        delete: op({
          summary: "Remove a step",
          description:
            "The step detaches: **the dataset it produced and its run " +
            "history both survive**, and a step that reads that dataset goes " +
            "on reading it as an ordinary workspace table. The answer says " +
            "what is true: whether that dataset `exists`, was " +
            "`deleted` since, or `never` was, and which steps read its name.",
          tag: "Recipes",
          tool: "remove_recipe_step", mcp: LOCAL_DELETE,
          display: {"verb": "Removed a step from the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "id")),
          confirmation: {"target": "Remove {target}?", "consequence": "This removes the node from its workflow. Existing output datasets and run history remain.", "subject": {"path": "/api/recipes/{id}/steps/{stepId}", "argument": "stepId", "name": "step.parameters.name"}},
          confirm: true,
          parameters: [
            pathParam("id", "Recipe id."),
            pathParam("stepId", "Step id."),
          ],
          responses: {
            "200": jsonOk("#/components/schemas/RecipeStepRemoved"),
          },
        }),
      },
      "/api/recipes/{id}/steps/{stepId}/proposal": {
        delete: op({
          summary: "Discard a step's pending edit",
          description:
            "Puts the step back to its active definition — what its output " +
            "was produced from — and changes nothing else. A step " +
            "holding no pending edit is unchanged, and `discarded` says so.",
          tag: "Recipes",
          tool: "discard_recipe_step_edit", mcp: LOCAL_REPLACE,
          display: {"verb": "Discarded a step's pending edit on the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "id")),
          parameters: [
            pathParam("id", "Recipe id."),
            pathParam("stepId", "Step id."),
          ],
          responses: {
            "200": jsonOk("#/components/schemas/RecipeStepDiscarded"),
          },
        }),
      },
      "/api/recipes/{id}/steps/{stepId}/move": {
        post: op({
          summary: "Reorder a step",
          description:
            WORKFLOW_JSON_BODY_BOUND +
            "Moves the step to a position, rewriting the ordinals densely. " +
            "**The whole proposed ordering is checked**, not just the step " +
            "that moved: dragging a producer downwards breaks its consumers " +
            "rather than itself, and a reorder that would leave the recipe " +
            "invalid is refused with nothing changed.",
          tag: "Recipes",
          tool: "move_recipe_step", mcp: LOCAL_REPLACE,
          display: {"verb": "Moved a step of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "id")),
          parameters: [
            pathParam("id", "Recipe id."),
            pathParam("stepId", "Step id."),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ordinal: {
                      type: "integer",
                      description: "Zero-based position to move it to.",
                    },
                  },
                  required: ["ordinal"],
                },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/RecipeEnvelope") },
        }),
      },
      "/api/recipes/{id}/steps/{stepId}/run": {
        post: op({
          summary: "Run one step",
          description:
            "Answers **202** with one of the recipe's runs: a " +
            "run of kind `single` with this one member, listed among the " +
            "recipe's runs and read and cancelled through them; poll " +
            "`/api/recipes/{id}/runs/{runId}` for its outcome. **This runs " +
            "the step and nothing else** — carrying its dependents is the " +
            "recipe-run endpoint's job.\n\n" +
            "A re-run replaces the step's output **in place**, keeping the " +
            "dataset's id and name, so every layer built on it keeps " +
            "pointing at fresh data with no re-wiring. A failed re-run " +
            "leaves the previous output intact and queryable.\n\n" +
            "**What a caller may rely on.** The recipe's one-run-at-a-time " +
            "rule applies: while a run is in flight this answers **409 " +
            "`run_in_flight`** naming it. Ordinarily, a step the API cannot " +
            "admit alone is refused before anything exists: no run, no " +
            "attempt. Narrow exception: if the run was already listable and " +
            "cancellation was accepted before that refusal, the cancelled " +
            "run remains with the refusal member and no attempt. The run " +
            "stays with the recipe after the step is removed.",
          tag: "Recipes",
          tool: "run_recipe_step", mcp: WORKFLOW_RUN,
          display: {"verb": "Ran a step of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "id"), resource("runs", "", "run.id"), resource("tables")),
          parameters: [
            pathParam("id", "Recipe id."),
            pathParam("stepId", "Step id."),
          ],
          responses: {
            "202": jsonOk(
              "#/components/schemas/RecipeRunEnvelope",
              "Accepted; poll the recipe run for its outcome.",
            ),
            "409": {
              description: "A run is already in flight (`run_in_flight`, naming it); nothing started.",
            },
          },
        }),
      },
      "/api/recipes/{id}/runs": {
        get: op({
          summary: "List a recipe's runs",
          description:
            "Every cascade this recipe has had, newest first, each durable " +
            "and readable long after it finished.",
          tag: "Recipes",
          tool: "list_recipe_runs", mcp: LOCAL_READ,
          display: {"verb": "Listed the runs of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Recipe id.")],
          responses: { "200": jsonOk("#/components/schemas/RecipeRunList") },
        }),
        post: op({
          summary: "Run a recipe, or a step and its dependents",
          description:
            WORKFLOW_JSON_BODY_BOUND +
            "Omit `fromStepId` to run the whole recipe from the beginning; " +
            "give one to re-run that step and everything that reads it, in " +
            "dependency order. A step starts only once every step it reads " +
            "has succeeded, and one whose dependency failed is **not " +
            "attempted** — reported `not_run`, minting no run at all, with " +
            "the failure that stopped it named. Steps that do not depend on " +
            "the failure still run.\n\n" +
            "**Ask first with `plan: true`.** It answers what the request " +
            "would carry without starting anything: `wide` is true for a run " +
            "of the whole recipe and for a re-run that carries dependents, " +
            "and false for the same request aimed at a step nothing reads. " +
            "That is what the `when_wide` confirmation on this operation " +
            "means — confirm the wide cases, not the leaf.\n\n" +
            "A recipe run is **not** an operation run: it answers **202** " +
            "with its own resource, which has its own outcome and contains " +
            "the members' ordinary runs.\n\n" +
            "**What a caller may rely on.** A recipe runs one " +
            "run at a time: a start while one is in flight — this operation's " +
            "or a single step's — answers **409 `run_in_flight`** naming the " +
            "run, and two starts that race yield one run and one refusal. " +
            "A start that names `members` — the step ids a confirmation " +
            "listed, in order — starts exactly when the plan at start is " +
            "that set in that order, and answers **409 `plan_changed`** " +
            "otherwise, nothing started; the binding is membership and " +
            "order only, never a member's definition, which is read when " +
            "the member is admitted. Each attempted member's record carries " +
            "its attempt — state, error, times, output — kept with the run " +
            "after the step's own history is pruned; a member never " +
            "attempted has none; every member keeps its step's operation " +
            "and name after the step is removed.",
          tag: "Recipes",
          tool: "run_recipe", mcp: WORKFLOW_RUN,
          display: {"verb": "Ran the workflow {subject}", "planningVerb": "Planned the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: planning("plan", writes(resource("recipes", "id"), resource("runs", "", "run.id"), resource("tables"))),
          confirmation: {"target": "Run {target}?", "consequence": "This runs the listed nodes in order and creates or replaces their output datasets.", "subject": {"path": "/api/recipes/{id}", "argument": "id", "name": "recipe.name"}},
          confirm: "when_wide",
          parameters: [pathParam("id", "Recipe id.")],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    fromStepId: {
                      type: "string",
                      description:
                        "Re-run this step and its dependents. Omitted, the " +
                        "whole recipe runs.",
                    },
                    plan: {
                      type: "boolean",
                      description:
                        "Report what would be carried, and whether that is " +
                        "wide, without starting anything.",
                    },
                    members: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "The step ids a confirmation listed, in order. Given, " +
                        "the run starts only when the plan at start is exactly " +
                        "that set in that order; otherwise 409 `plan_changed`.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonOk(
              "#/components/schemas/RecipeRunPlan",
              "What this would carry; nothing started.",
            ),
            "202": jsonOk(
              "#/components/schemas/RecipeRunEnvelope",
              "Accepted; poll the recipe run for its outcome.",
            ),
            "409": {
              description:
                "A run is already in flight (`run_in_flight`, naming it), or " +
                "the plan no longer matches the confirmed `members` " +
                "(`plan_changed`); nothing started.",
            },
          },
        }),
      },
      "/api/recipes/{id}/runs/{runId}": {
        get: op({
          summary: "Read a recipe run",
          description:
            "Its own outcome — completed, partly completed, failed, " +
            "cancelled or interrupted — every member with what became of it, " +
            "and every dataset it produced. A member reported `not_run` " +
            "carries **no** run id, because nothing was minted for it.",
          tag: "Recipes",
          tool: "get_recipe_run", mcp: LOCAL_READ,
          display: {"verb": "Read a run of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [
            pathParam("id", "Recipe id."),
            pathParam("runId", "Recipe run id."),
          ],
          responses: { "200": jsonOk("#/components/schemas/RecipeRunEnvelope") },
        }),
      },
      "/api/recipes/{id}/runs/{runId}/cancel": {
        post: op({
          summary: "Cancel a recipe run",
          description:
            "One thing to stop, whatever it was in the middle of: what has " +
            "not started never starts. Every member found running when " +
            "cancellation is accepted is cancelled before any member " +
            "settlement is awaited; only a member already terminal at " +
            "acceptance stays finished, and its output stands. Running " +
            "members are interrupted **in the engine**, not only in the " +
            "record. The run's own " +
            "outcome is then `cancelled`, written once the last in-flight " +
            "member has settled. Cancelling one that has already finished " +
            "is not an error.",
          tag: "Recipes",
          tool: "cancel_recipe_run", mcp: LOCAL_REPLACE,
          display: {"verb": "Cancelled a run of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
          effects: writes(resource("recipes", "id"), resource("runs", "runId")),
          parameters: [
            pathParam("id", "Recipe id."),
            pathParam("runId", "Recipe run id."),
          ],
          responses: { "200": jsonOk("#/components/schemas/RecipeRunEnvelope") },
        }),
      },
      "/api/query": {
        post: op({
          summary: "Run read-only SQL",
          description:
            "Only read-only SELECT queries are accepted. Returns a capped " +
            "preview plus the exact total row count. Geometry cells in the " +
            "preview are WKT text by default; pass geometry: \"geojson\" " +
            "to receive GeoJSON geometry objects instead. A " +
            "failing statement answers with the engine's message and, when " +
            "the engine reports where, a 1-based line and column into the " +
            "submitted SQL.",
          tag: "Query",
          tool: "run_sql", mcp: LOCAL_READ,
          display: {"verb": "Ran a query"},
          effects: READ_ONLY,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sql: { type: "string" },
                    geometry: {
                      type: "string",
                      enum: ["wkt", "geojson"],
                      description:
                        "How geometry columns travel in the preview. " +
                        "Default wkt.",
                    },
                  },
                  required: ["sql"],
                },
                example: { sql: "SELECT * FROM my_table LIMIT 100" },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/QueryResult") },
        }),
      },
      "/api/query/export": {
        post: op({
          summary: "Download a query's full result",
          description:
            "Every row the SQL produces — not the capped preview " +
            "the query operation returns — as a file: csv, geoparquet " +
            "(plain parquet when the result has no geometry), or geojson, " +
            "which needs a geometry column and is refused with a coded " +
            "reason otherwise. The first geometry column is the feature " +
            "geometry; every other geometry column travels as WKT. Runs on " +
            "the hardened read-only instance under the universal query " +
            "bound — timeout, memory budget, and cancellation when the " +
            "caller departs. The response is an attachment named " +
            "<name>.<ext>; through the agent tool it arrives as a base64 " +
            "attachment envelope.",
          tag: "Query",
          tool: "export_sql_result", mcp: LOCAL_TRANSIENT_READ,
          toolOutput: { binary: { representation: "attachment", nativeImage: false } },
          display: {"verb": "Exported a query result"},
          relevance: ["sql"],
          effects: READ_ONLY,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sql: { type: "string" },
                    format: {
                      type: "string",
                      enum: ["geoparquet", "geojson", "csv"],
                    },
                    name: {
                      type: "string",
                      description:
                        "Download name without extension. Default " +
                        "query_result.",
                    },
                    prepare: {
                      type: "boolean",
                      description:
                        "The page's road: write the file and answer a " +
                        "single-use ticket instead of the bytes; redeem it " +
                        "with GET within a minute. Leave unset to receive " +
                        "the attachment directly.",
                    },
                  },
                  required: ["sql", "format"],
                },
                example: {
                  sql: "SELECT * FROM my_table",
                  format: "csv",
                  name: "my_table_result",
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "The file, as an attachment — or, with prepare, a JSON " +
                "ticket {ticket, key, format}.",
              content: {
                "application/json": QUERY_EXPORT_TICKET,
                "application/octet-stream": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            "400": {
              description:
                "Unknown format, GeoJSON without geometry, invalid SQL, or " +
                "the bounded lane's coded errors.",
            },
          },
        }),
        get: op({
          summary: "Redeem a prepared query-result download",
          description:
            "The second half of the page's download road: a " +
            "ticket from a prepare call streams its file once as a native " +
            "attachment, bound to the SQL key and format it was prepared " +
            "for. Tickets expire after a minute; a redeemed, expired or " +
            "mismatched ticket answers 410. Not an agent tool — agents call " +
            "the POST directly.",
          tag: "Query",
          tool: false,
          effects: READ_ONLY,
          parameters: [
            {
              name: "ticket",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "The ticket the prepare call answered.",
            },
            {
              name: "key",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "The key the prepare call answered.",
            },
            {
              name: "format",
              in: "query",
              required: true,
              schema: {
                type: "string",
                enum: ["geoparquet", "geojson", "csv"],
              },
              description: "The format the ticket was prepared for.",
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
            "410": { description: "The ticket is gone." },
          },
        }),
      },
      "/api/maps": {
        get: op({
          summary: "List maps",
          tag: "Maps",
          tool: "list_maps", mcp: LOCAL_READ,
          display: {"verb": "Listed the maps"},
          effects: READ_ONLY,
          parameters: [PROJECT_SCOPE_PARAM],
          responses: { "200": jsonOk("#/components/schemas/MapList") },
        }),
        post: op({
          summary: "Create a map",
          description:
            "Optionally filed into a project at birth: an " +
            "unknown project refuses and creates nothing.",
          tag: "Maps",
          tool: "create_map", mcp: LOCAL_ADD,
          display: {"verb": "Created the map {subject}", "subject": {"resource": "maps", "result": "id", "name": ["name"]}},
          effects: writes(resource("maps", "", "id"), resource("projects")),
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    projectId: {
                      type: ["string", "null"],
                      description:
                        "The project the new map joins; omitted or null, " +
                        "it starts unfiled.",
                    },
                  },
                },
                example: { name: "My map" },
              },
            },
          },
          responses: { "201": jsonOk("#/components/schemas/Map", "Created.") },
        }),
      },
      "/api/projects": {
        get: op({
          summary: "List projects",
          description:
            "Every project with its member counts (maps, workflows as " +
            "workflow-origin recipes, " +
            "datasets, published maps), its size total — `sizeComplete` " +
            "is false when a member dataset's size is unknown, so the sum " +
            "is honest about being partial — and when it last changed. " +
            "Most recent first.",
          tag: "Projects",
          tool: "list_projects", mcp: LOCAL_READ,
          display: {"verb": "Listed the projects"},
          effects: READ_ONLY,
          responses: { "200": jsonOk("#/components/schemas/ProjectList") },
        }),
        post: op({
          summary: "Create a project",
          description:
            "The name is trimmed, must not be empty, and is at most 120 " +
            "characters; two projects may share one. `members` files " +
            "initial members in the same act — one invalid member means " +
            "nothing is created at all. Only workflows can " +
            "be project members.",
          tag: "Projects",
          tool: "create_project", mcp: LOCAL_ADD,
          display: {"verb": "Created the project {subject}", "subject": {"resource": "projects", "result": "id", "name": ["name"]}},
          effects: writes(resource("projects", "", "id")),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    note: { type: ["string", "null"] },
                    members: {
                      $ref: "#/components/schemas/ProjectMemberChange",
                    },
                  },
                  required: ["name"],
                },
                example: { name: "Berlin mobility study" },
              },
            },
          },
          responses: {
            "201": jsonOk("#/components/schemas/Project", "Created."),
          },
        }),
      },
      "/api/projects/{id}": {
        get: op({
          summary: "Read a project",
          description:
            "One project with its member counts and size. Its workflows " +
            "are workflow-origin recipes.",
          tag: "Projects",
          tool: "get_project", mcp: LOCAL_READ,
          display: {"verb": "Read the project {subject}", "subject": {"resource": "projects", "argument": "id", "name": ["name"]}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Project id.")],
          responses: { "200": jsonOk("#/components/schemas/Project") },
        }),
        patch: op({
          summary: "Rename a project or edit its note",
          description:
            "Renaming and the note follow the creation rules; a null " +
            "note clears it. Membership is not edited here — that is " +
            "the members operation.",
          tag: "Projects",
          tool: "update_project", mcp: LOCAL_REPLACE,
          display: {"verb": "Updated the project {subject}", "subject": {"resource": "projects", "argument": "id", "name": ["name"]}},
          effects: writes(resource("projects", "id")),
          parameters: [pathParam("id", "Project id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    note: { type: ["string", "null"] },
                  },
                },
                example: { note: "Rings, catchments, lane density." },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/Project") },
        }),
        delete: op({
          summary: "Delete a project",
          description:
            "The set dissolves: memberships are removed and every map, " +
            "workflow, dataset and artifact remains, unfiled unless " +
            "another project holds it. The response says so explicitly.",
          tag: "Projects",
          tool: "delete_project", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted the project {subject}", "subject": {"resource": "projects", "argument": "id"}},
          effects: writes(resource("projects", "id")),
          confirmation: {"target": "Delete {target}?", "consequence": "This dissolves the project. Its maps, workflows and datasets remain.", "subject": {"path": "/api/projects/{id}", "argument": "id", "name": "name"}},
          confirm: true,
          parameters: [pathParam("id", "Project id.")],
          responses: {
            "200": {
              description: "Dissolved; contents remain.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      deleted: { type: "boolean" },
                      contentsRemain: { type: "boolean" },
                      message: { type: "string" },
                    },
                    required: ["deleted", "contentsRemain", "message"],
                  },
                },
              },
            },
          },
        }),
      },
      "/api/projects/{id}/members": {
        get: op({
          summary: "Read a project's members",
          description:
            "The composite: the project's maps, workflow-origin recipes " +
            "and datasets, each in its ordinary listing shape and order. " +
            "The response field remains `recipes`.",
          tag: "Projects",
          tool: "get_project_members", mcp: LOCAL_READ,
          display: {"verb": "Read the members of the project {subject}", "subject": {"resource": "projects", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Project id.")],
          responses: { "200": jsonOk("#/components/schemas/ProjectMembers") },
        }),
        patch: op({
          summary: "Change a project's members",
          description:
            "One atomic change: adds and removes for maps, " +
            "recipes and datasets together — everything applies or " +
            "nothing does. Only workflows can be project " +
            "members. Adding a map or eligible recipe moves it from any " +
            "previous project; adding a dataset adds another membership; " +
            "repeated adds are idempotent. Answers the updated composite.",
          tag: "Projects",
          tool: "update_project_members", mcp: LOCAL_REPLACE,
          display: {"verb": "Changed the members of the project {subject}", "subject": {"resource": "projects", "argument": "id", "name": ["name"]}},
          effects: writes(resource("projects", "id")),
          parameters: [pathParam("id", "Project id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProjectMemberChange" },
                example: {
                  addMaps: ["map-id"],
                  addTables: ["table-id-1", "table-id-2"],
                },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/ProjectMembers") },
        }),
      },
      "/api/projects/{id}/export": {
        post: op({
          summary: "Export a project as one archive",
          description:
            "A chosen subset of the project's members as one zip: " +
            "datasets byte for byte as their stored " +
            "GeoParquet artifacts — or, with datasetFormat, " +
            "every dataset converted to GeoJSON or CSV, a dataset without " +
            "geometry going as CSV under GeoJSON and the manifest naming " +
            "each dataset's effective format — maps and workflows " +
            "(workflow-origin recipes) as portable JSON " +
            "projections (publication state, membership and runtime " +
            "stripped; the workflow carries its canvas layout), and a " +
            "versioned project.json manifest naming every included " +
            "member. The archive is assembled and finalized before any " +
            "success is claimed — a failed assembly is a coded refusal, " +
            "never a truncated file. Refuses an unknown project, an " +
            "empty selection, and any id that is not a current member. " +
            "The response is an attachment named <file>.zip; through " +
            "the agent tool it arrives as a base64 attachment envelope. " +
            "With prepare, a single-use ticket instead — the page's " +
            "road; redeem it with GET within a minute.",
          tag: "Projects",
          tool: "export_project", mcp: LOCAL_TRANSIENT_READ,
          toolOutput: { binary: { representation: "attachment", nativeImage: false } },
          display: {"verb": "Exported the project {subject}", "subject": {"resource": "projects", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Project id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    maps: {
                      type: "array",
                      items: { type: "string" },
                      description: "Member map ids to include.",
                    },
                    workflows: {
                      type: "array",
                      items: { type: "string" },
                      description: "Member workflow ids to include.",
                    },
                    datasets: {
                      type: "array",
                      items: { type: "string" },
                      description: "Member dataset ids to include.",
                    },
                    file: {
                      type: "string",
                      description:
                        "Archive base name; normalized to file form, " +
                        "falling back to \"project\".",
                    },
                    prepare: {
                      type: "boolean",
                      description:
                        "Answer a single-use ticket {ticket, key, " +
                        "filename, size} instead of the bytes.",
                    },
                    datasetFormat: {
                      type: "string",
                      enum: ["geoparquet", "geojson", "csv"],
                      default: "geoparquet",
                      description:
                        "One format for every dataset in the archive" +
                        ". Omitted or geoparquet: the stored " +
                        "artifact byte for byte. geojson: spatial datasets " +
                        "as GeoJSON, a dataset without geometry as CSV. " +
                        "csv: geometry as WKT text. The manifest records " +
                        "each dataset's effective format beside its file; " +
                        "the format version stays 1.",
                    },
                  },
                },
                example: {
                  maps: ["map-id"],
                  datasets: ["table-id"],
                  file: "berlin-mobility-study",
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "The zip attachment — or, with prepare, the JSON ticket.",
              content: {
                "application/json": PROJECT_EXPORT_TICKET,
                "application/zip": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
          },
        }),
        get: op({
          summary: "Redeem a prepared project export",
          description:
            "The second half of the page's download road: a ticket " +
            "from a prepare call streams its " +
            "finalized archive once as a native attachment. Tickets " +
            "expire after a minute; a redeemed, expired or mismatched " +
            "ticket answers 410 and the staged file is discarded. Not an " +
            "agent tool — agents call the POST directly.",
          tag: "Projects",
          tool: false,
          effects: READ_ONLY,
          parameters: [
            pathParam("id", "Project id."),
            {
              name: "ticket",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "The ticket the prepare call answered.",
            },
            {
              name: "key",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "The key the prepare call answered.",
            },
          ],
          responses: {
            "200": {
              description: "The zip attachment, once.",
              content: {
                "application/zip": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
          },
        }),
      },
      "/api/icons/sanitize": {
        post: op({
          summary: "Sanitize custom icon SVG",
          description:
            "Advisory pass of the custom-icon sanitizer: " +
            "returns the accepted markup, whether anything changed, and " +
            "a bounded report of dropped content (category and name). " +
            "The layer write re-sanitizes — this exists so a picker or " +
            "agent can preview the outcome. Not-SVG, oversize, and " +
            "nothing-drawable inputs answer invalid_request.",
          tag: "Layers",
          tool: "sanitize_icon_svg", mcp: LOCAL_READ,
          display: {"verb": "Sanitized an icon"},
          relevance: [],
          effects: READ_ONLY,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { svg: { type: "string" } },
                  required: ["svg"],
                },
                example: { svg: "<svg viewBox=\"0 0 24 24\">…</svg>" },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/SanitizedIcon"),
          },
        }),
      },
      "/api/basemap/inspect": {
        post: op({
          summary: "Inspect a custom basemap style URL",
          description:
            "One bounded fetch through the egress policy, " +
            "answering valid | not_style | unreachable | blocked with a " +
            "summary and attribution preview. Advisory: the map write " +
            "re-inspects before saving. Verdicts are 200s — a dead URL is " +
            "a normal thing to ask about.",
          tag: "Maps",
          tool: "inspect_basemap_style", mcp: REMOTE_READ,
          display: {"verb": "Inspected a basemap style"},
          relevance: [],
          effects: READ_ONLY,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { url: { type: "string" } },
                  required: ["url"],
                },
                example: { url: "https://tiles.example/styles/dark.json" },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/StyleInspection"),
          },
        }),
      },
      "/api/maps/{id}": {
        get: op({
          summary: "Read a map with its layers",
          tag: "Maps",
          tool: "get_map", mcp: LOCAL_READ,
          display: {"verb": "Read the map {subject}", "subject": {"resource": "maps", "argument": "id", "name": ["name"]}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          responses: {
            "200": jsonOk("#/components/schemas/MapWithLayers"),
          },
        }),
        patch: op({
          summary: "Update a map",
          description:
            "Any of name, viewport, basemap (dark | light | streets | " +
            "satellite, or null for Auto — the builder follows the app " +
            "theme; published views follow the publication's effective " +
            "theme, unless a deployment override pins Auto), " +
            "basemapLayers (per-group basemap " +
            "visibility; null shows everything), legendCorner (null = " +
            "bottom-left), legendOrder (the manual legend arrangement; " +
            "null follows the layer panel), timeline " +
            "(the docked playback timeline; null undocks), " +
            "widgets (the ordered widget list, notes included), " +
            "widgetsPublished (whether widgets ship with the " +
            "published view), or layer order. The former `note` field " +
            "retired into a note widget.",
          tag: "Maps",
          tool: "update_map", mcp: REMOTE_REPLACE,
          display: {"verb": "Updated the map {subject}", "subject": {"resource": "maps", "argument": "id", "name": ["name"]}},
          effects: recorded(writes(resource("maps", "id"))),
          parameters: [pathParam("id", "Map id."), changeGroupParam],
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MapUpdate" },
                example: { viewport: { lng: 13.4, lat: 52.5, zoom: 10 } },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/MapWithLayers"),
          },
        }),
        delete: op({
          summary: "Delete a map",
          tag: "Maps",
          tool: "delete_map", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          effects: writes(resource("maps", "id"), resource("layers"), resource("publications", "id"), resource("projects")),
          confirmation: {"target": "Delete {target}?", "consequence": "This deletes the map and its layers and stops its published link.", "subject": {"path": "/api/maps/{id}", "argument": "id", "name": "name"}},
          confirm: true,
          parameters: [pathParam("id", "Map id.")],
          responses: { "204": { description: "Deleted." } },
        }),
      },
      "/api/maps/{id}/thumbnail": {
        get: op({
          summary: "Read a map's snapshot",
          description:
            "The PNG the builder last captured for this map — the " +
            "maps screen's card image. 404 while no capture exists. A map " +
            "whose basemap follows the theme carries one image per theme: " +
            "name the theme to read that one. The fallback order: " +
            "the named theme's image, then the map's single image, then " +
            "the other theme's; a request naming no theme answers the " +
            "single image, then light, then dark. Only a map with no " +
            "image at all is refused.",
          tag: "Maps",
          // UI sugar, not a map capability — outside the agent tool set.
          tool: false,
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id."), THUMBNAIL_THEME_PARAM],
          responses: {
            "200": {
              description: "The snapshot.",
              content: { "image/png": { schema: { type: "string", format: "binary" } } },
            },
            "404": { description: "No snapshot yet." },
          },
        }),
        put: op({
          summary: "Store a map's snapshot",
          description:
            "A PNG body, at most 4 MB — captured by the builder after " +
            "edits settle. Without a theme the body is the map's " +
            "one image and replaces whatever it had. With a theme and a " +
            "cycle the body is one half of a themed pair: it is " +
            "held until the other theme arrives under the same cycle, and " +
            "the pair then replaces everything the map had, together. A " +
            "cycle that never completes leaves the map's images as they " +
            "were; a later cycle's completion discards it.",
          tag: "Maps",
          tool: false,
          effects: writes(resource("maps", "id")),
          parameters: [
            pathParam("id", "Map id."),
            THUMBNAIL_THEME_PARAM,
            {
              name: "cycle",
              in: "query",
              required: false,
              schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
              description:
                "The capture cycle a themed snapshot belongs to; required " +
                "with a theme, refused without one. Two writes carrying " +
                "the same cycle and different themes form one pair.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
            },
          },
          responses: {
            "204": { description: "Stored: the map's images are replaced." },
            "202": {
              description:
                "Held: a themed snapshot waiting for its partner under the " +
                "same cycle. The map's images are unchanged.",
            },
          },
        }),
      },
      "/api/maps/{id}/widget-values": {
        post: op({
          summary: "Read the map's widget values",
          description:
            "Every visible widget computed server-side over its layer's " +
            "effective query, under an optional ephemeral " +
            "selection set — cross-filter state that lives on the request " +
            "and is never stored. Classic crossfilter semantics: a widget's " +
            "own selection never filters itself. Also returns per-layer " +
            "constrained/total row counts. A read, despite the POST — the " +
            "body carries the selections. An optional draft widget" +
            " previews an unsaved editor state: validated like a " +
            "stored widget, it replaces its stored self by id (or joins as " +
            "a new card) for this computation only — nothing is written.",
          tag: "Maps",
          tool: "read_widget_values", mcp: LOCAL_READ,
          display: {"verb": "Read the widget values of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          relevance: [],
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    selections: {
                      $ref: "#/components/schemas/WidgetSelections",
                    },
                    draft: {
                      $ref: "#/components/schemas/MapWidget",
                    },
                  },
                },
                example: {
                  selections: [
                    { widgetId: "w1", kind: "exclude", values: ["Nordend"] },
                  ],
                },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/WidgetValues") },
        }),
      },
      "/api/maps/{id}/search": {
        get: op({
          summary: "Search the map",
          description:
            "One search over the map's own data and, on request, places " +
            ": visible layers matched by name, attribute values " +
            "matched case-insensitively in genuine text columns of each " +
            "visible layer's effective (filtered) result — one row per " +
            "matching feature, at most 20 across layers, on the hardened " +
            "read-only path — and every plausible reading of a pasted " +
            "decimal coordinate pair. With `places=1` and a configured " +
            "provider endpoint, Nominatim-compatible place results join, " +
            "carrying the provider's attribution; unconfigured, the places " +
            "group answers `unconfigured` and everything local still " +
            "works. Value and place rows carry the geometry a client needs " +
            "to fly or fit without a second request. Never builder actions.",
          tag: "Maps",
          tool: "search_map", mcp: REMOTE_READ,
          display: {"verb": "Searched the map {subject} for {arg.q}", "subject": {"resource": "maps", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [
            pathParam("id", "Map id."),
            {
              name: "q",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "The search text.",
            },
            {
              name: "places",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["1"] },
              description:
                "Ask for places too — the submitted search. Omitted, the " +
                "provider is never contacted (the per-keystroke path).",
            },
          ],
          responses: { "200": jsonOk("#/components/schemas/SearchResults") },
        }),
      },
      "/api/maps/{id}/dependencies": {
        get: op({
          summary: "The datasets a map draws from",
          description:
            "The 14-A filing checklist's subject: every " +
            "registered dataset used by at least one of the map's saved " +
            "layers, exactly once, with its source, row count, project " +
            "memberships, and the workflow-origin recipe that currently " +
            "produces it (null otherwise), and its geometry column and " +
            "sampled geometry type (both null for a non-spatial dataset; " +
            "a column with no sampled type is still spatial). A layer whose " +
            "statement cannot be analyzed fails the whole read with " +
            "`dependencies_unresolved` — a partial answer never presents " +
            "as a complete checklist.",
          tag: "Maps",
          tool: "get_map_dependencies", mcp: LOCAL_READ,
          display: {"verb": "Read the datasets of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          responses: {
            "200": jsonOk("#/components/schemas/MapDependencies"),
          },
        }),
      },
      "/api/maps/{id}/duplicate": {
        post: op({
          summary: "Duplicate a map",
          description:
            "Full copy — viewport, basemap, note, legend, timeline dock, and " +
            "every layer under fresh ids — named \"<name> copy\", always an " +
            "unpublished draft. Edit history does not carry over.",
          tag: "Maps",
          tool: "duplicate_map", mcp: LOCAL_ADD,
          display: {"verb": "Duplicated a map as {subject}", "subject": {"resource": "maps", "result": "id", "name": ["name"]}},
          effects: writes(resource("maps", "", "id"), resource("layers"), resource("projects")),
          parameters: [pathParam("id", "Map id.")],
          responses: {
            "201": jsonOk("#/components/schemas/MapWithLayers", "Created."),
          },
        }),
      },
      ...HISTORY_PATHS,
      "/api/maps/{id}/sketches": {
        get: op({
          summary: "List a map's sketch datasets",
          description:
            "The sketch datasets drawn on this map, each with its " +
            "table, owning layer and per-kind feature counts — what the " +
            "builder's card copy and cascade confirmation read.",
          tag: "Sketches",
          tool: "list_map_sketches", mcp: LOCAL_READ,
          display: {"verb": "Listed the sketches of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          responses: {
            "200": {
              description: "The map's sketches.",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        table: { type: "string" },
                        tableId: { type: "string" },
                        mapId: { type: "string" },
                        layerId: { type: ["string", "null"] },
                        rowCount: { type: "integer" },
                        counts: {
                          type: "object",
                          description: "Feature count per drawn kind.",
                        },
                      },
                      required: ["table", "tableId", "mapId", "rowCount"],
                    },
                  },
                },
              },
            },
          },
        }),
        post: op({
          summary: "Start a sketch with its first feature",
          description:
            "First commit of a draw session: mints the sketch " +
            "dataset — named from the map's name plus _sketch, advancing " +
            "a visible numeric suffix on collision — and its owning layer " +
            "together, provenance recorded, no history step. The feature " +
            "passes the same structural gate as every later commit: kind " +
            "one of point, line, polygon, rectangle, circle, freehand; " +
            "geometry the kind's GeoJSON family (polygon kinds are one " +
            "closed ring, no holes); at most 10,000 vertices.",
          tag: "Sketches",
          tool: "create_sketch", mcp: LOCAL_ADD,
          display: {"verb": "Started a sketch on the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          effects: writes(resource("tables", "", "tableId"), resource("layers", "", "layerId"), resource("maps", "id")),
          parameters: [pathParam("id", "Map id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["feature"],
                  properties: {
                    feature: {
                      type: "object",
                      required: ["kind", "geometry"],
                      properties: {
                        kind: {
                          type: "string",
                          enum: [
                            "point",
                            "line",
                            "polygon",
                            "rectangle",
                            "circle",
                            "freehand",
                          ],
                        },
                        geometry: {
                          type: "object",
                          description:
                            "GeoJSON Point, LineString or Polygon " +
                            "matching the kind.",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "The minted sketch.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      table: { type: "string" },
                      tableId: { type: "string" },
                      layerId: { type: "string" },
                      layerName: { type: "string" },
                      featureId: { type: "string" },
                    },
                    required: ["table", "layerId", "featureId"],
                  },
                },
              },
            },
            "400": { description: "The feature failed the structural gate." },
          },
        }),
      },
      "/api/sketches/{name}/features": {
        get: op({
          summary: "Read a sketch's drawn features",
          description:
            "Every drawn feature with its stable id, kind and geometry " +
            "— the identity the select tool and vertex handles use.",
          tag: "Sketches",
          tool: "get_sketch_features", mcp: LOCAL_READ,
          display: {"verb": "Read the features of the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
          effects: READ_ONLY,
          parameters: [pathParam("name", "Sketch table name.")],
          responses: {
            "200": {
              description: "The features.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { features: { type: "array" } },
                    required: ["features"],
                  },
                },
              },
            },
          },
        }),
        post: op({
          summary: "Append one drawn feature",
          description:
            "Commits one more shape into the session's dataset, " +
            "under the same structural gate and vertex ceiling as the " +
            "first. The dataset's id and name never change; the artifact " +
            "is rewritten and every dependent layer's render refreshes.",
          tag: "Sketches",
          tool: "append_sketch_feature", mcp: LOCAL_ADD,
          display: {"verb": "Added a feature to the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
          effects: writes(resource("tables", "name")),
          parameters: [pathParam("name", "Sketch table name.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["feature"],
                  properties: { feature: { type: "object" } },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "The appended feature's id and the new count.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      featureId: { type: "string" },
                      rowCount: { type: "integer" },
                    },
                    required: ["featureId", "rowCount"],
                  },
                },
              },
            },
            "400": { description: "The feature failed the structural gate." },
            "409": {
              description: "The sketch vanished mid-flight; nothing written.",
            },
          },
        }),
      },
      "/api/sketches/{name}/features/{featureId}": {
        patch: op({
          summary: "Move one vertex of a drawn polygon",
          description:
            "The one permitted edit: move exactly one vertex of a " +
            "polygon or freehand feature. Kind and vertex count are " +
            "preserved; points, lines, rectangles and circles refuse; the " +
            "moved ring passes the same structural gate as a fresh commit.",
          tag: "Sketches",
          tool: "move_sketch_vertex", mcp: LOCAL_REPLACE,
          display: {"verb": "Moved a vertex of the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
          effects: writes(resource("tables", "name")),
          parameters: [
            pathParam("name", "Sketch table name."),
            pathParam("featureId", "Drawn feature id."),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["vertexIndex", "position"],
                  properties: {
                    vertexIndex: {
                      type: "integer",
                      description:
                        "Ring index, 0-based, excluding the closing " +
                        "position; moving index 0 moves the closure too.",
                    },
                    position: {
                      type: "array",
                      description: "[longitude, latitude], in range.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": SKETCH_ROW_COUNT_RESPONSE,
            "400": { description: "Bad index or out-of-range position." },
            "409": { description: "Not a polygon-kind feature." },
          },
        }),
        delete: op({
          summary: "Delete one drawn feature",
          description:
            "Removes exactly that row. The dataset keeps its id " +
            "and name; deleting the last row leaves the empty dataset " +
            "and its layer in place.",
          tag: "Sketches",
          tool: "delete_sketch_feature", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted a feature of the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
          effects: writes(resource("tables", "name")),
          parameters: [
            pathParam("name", "Sketch table name."),
            pathParam("featureId", "Drawn feature id."),
          ],
          responses: {
            "200": SKETCH_ROW_COUNT_RESPONSE,
            "404": { description: "No such drawn feature." },
          },
        }),
      },
      "/api/sketches/{name}": {
        delete: op({
          summary: "Delete a sketch and its owning layer — the cascade",
          description:
            "Deletes the provenance-named owning layer, its bound " +
            "widgets, the dataset, the artifact and the tile artifacts " +
            "together. Deliberately not undoable: no history step " +
            "is written and steps targeting the owner leave the timeline. " +
            "Copies and other layers over the same table keep ordinary " +
            "deletion behavior and enter the standing missing-table state.",
          tag: "Sketches",
          tool: "delete_sketch", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
          effects: writes(resource("tables", "name"), resource("layers"), resource("maps")),
          parameters: [pathParam("name", "Sketch table name.")],
          responses: {
            "204": { description: "Layer and dataset are gone." },
            "404": { description: "Not a sketch dataset." },
          },
        }),
      },
      "/api/maps/{id}/layers": {
        get: op({
          summary: "List a map's layers",
          tag: "Layers",
          tool: "list_layers", mcp: LOCAL_READ,
          display: {"verb": "Listed the layers of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          responses: { "200": jsonOk("#/components/schemas/LayerList") },
        }),
        post: op({
          summary: "Create a layer from a SQL result",
          description:
            "The SQL must return at least one geometry column. The first " +
            "geometry column in select order is the primary geometry used " +
            "for simple rendering; additional geometry columns are allowed. " +
            "A default, publication-ready style is applied when none is provided.",
          tag: "Layers",
          tool: "create_layer", mcp: LOCAL_ADD,
          display: {"verb": "Created the layer {subject}", "subject": {"resource": "layers", "result": "id", "name": ["name"]}},
          effects: recorded(writes(resource("layers", "", "id"), resource("maps"))),
          parameters: [pathParam("id", "Map id."), changeGroupParam],
          requestBody: {
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
          responses: { "201": jsonOk("#/components/schemas/Layer", "Created.") },
        }),
      },
      "/api/layers/{id}": {
        get: op({
          summary: "Read a layer",
          tag: "Layers",
          tool: "get_layer", mcp: LOCAL_READ,
          display: {"verb": "Read the layer {subject}", "subject": {"resource": "layers", "argument": "id", "name": ["name"]}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Layer id.")],
          responses: { "200": jsonOk("#/components/schemas/Layer") },
        }),
        patch: op({
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
          parameters: [pathParam("id", "Layer id."), changeGroupParam],
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LayerUpdate" },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/Layer") },
        }),
        delete: op({
          summary: "Delete a layer",
          description:
            "Recorded on the undo timeline — an undo restores the layer " +
            "whole.",
          tag: "Layers",
          tool: "delete_layer", mcp: LOCAL_DELETE,
          display: {"verb": "Deleted the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
          effects: recorded(writes(resource("layers", "id"), resource("maps"), resource("tables"))),
          confirmation: {"target": "Delete {target}?", "consequence": "This removes the layer and its bound widgets. An owning sketch layer also deletes its sketch dataset.", "subject": {"path": "/api/layers/{id}", "argument": "id", "name": "name"}},
          confirm: true,
          parameters: [pathParam("id", "Layer id."), changeGroupParam],
          responses: { "204": { description: "Deleted." } },
        }),
      },
      "/api/layers/{id}/duplicate": {
        post: op({
          summary: "Duplicate a layer",
          description:
            "Full copy — SQL, style, viz, filters, tooltip, legend settings — " +
            "with a suffixed name, stacked on top of the map's layer order.",
          tag: "Layers",
          tool: "duplicate_layer", mcp: LOCAL_ADD,
          display: {"verb": "Duplicated a layer as {subject}", "subject": {"resource": "layers", "result": "id", "name": ["name"]}},
          effects: recorded(writes(resource("layers", "", "id"), resource("maps"))),
          parameters: [pathParam("id", "Layer id."), changeGroupParam],
          responses: { "201": jsonOk("#/components/schemas/Layer", "Created.") },
        }),
      },
      "/api/layers/{id}/extent": {
        post: op({
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
        }),
      },
      "/api/maps/look": {
        post: op({
          summary: "Look at a map: one bounded rendered image with its facts",
          description:
            "The model-facing check of a map: the map's stored " +
            "state rendered through the same server-side road as the image " +
            "export, at 1024 by 640 pixels, and answered as a PNG of at most " +
            "384 KiB together with the render's facts. The image is derived " +
            "from that one render downwards through 768 by 480 and 512 by 320 " +
            "when the byte bound is missed; still over it at 512 by 320 the " +
            "answer is look_image_too_large and no image. The facts carry the " +
            "render's identity, the bounded state identity of what the renderer " +
            "actually drew (the map, the camera, the visible layers with a digest " +
            "of their stored filters, the legend and the widgets, the appearance), " +
            "the image's pixel and byte sizes, the source size, the attribution " +
            "credited, the composition's truthful failures and any abandoned " +
            "external requests, and the elapsed time. The appearance is an " +
            "explicit input, light when absent; mapId names the map, and a call " +
            "naming none answers look_target_missing. Read-only: the map's stored " +
            "state stays as it is; the image is retained in process for " +
            "GET /api/maps/look/{renderId} under documented bounds. Bounded by " +
            "its own budget (30 s by default, DEZFIL_ASSISTANT_LOOK_TIMEOUT_S), " +
            "queue wait, render and image preparation included; past it the " +
            "answer is render_timeout. Without a renderer browser on the " +
            "instance the answer is render_unavailable.",
          tag: "Maps",
          tool: "look_at_map", mcp: MAP_LOOK,
          toolOutput: { binary: { representation: "json-image", nativeImage: false } },
          display: {"verb": "Checked the map"},
          effects: READ_ONLY,
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    mapId: { type: "string", description: "The map to look at. The assistant supplies the contextual map when the model names none; a headless call without one answers look_target_missing." },
                    appearance: { type: "string", enum: ["light", "dark"], description: "The theme to render with. Light when absent." },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/MapLook", "The image and the render's facts."),
            "400": { description: "No map named (look_target_missing), or a malformed map id or appearance (invalid_request)." },
            "404": { description: "No such map (not_found)." },
            "408": { description: "The check's budget was exceeded (render_timeout)." },
            "413": { description: "No image fits the byte bound at any documented size (look_image_too_large)." },
            "502": { description: "The render failed or the renderer did not report what it drew (render_failed)." },
            "503": { description: "No renderer browser on this instance (render_unavailable)." },
          },
        }),
      },
      "/api/maps/look/{renderId}": {
        get: op({
          summary: "Read the retained image of a map check",
          description:
            "Exactly the PNG a check handed the model, or " +
            "the thumbnail derived from it at retention, as an attachment. " +
            "Renders are retained in process under documented bounds, 256 " +
            "renders and 96 MiB by default (DEZFIL_ASSISTANT_LOOK_RETENTION, " +
            "DEZFIL_ASSISTANT_LOOK_RETENTION_MB), full images and thumbnails " +
            "counted together, oldest evicted first, gone with the process. " +
            "After eviction or a restart the answer is look_image_unavailable; " +
            "this read renders nothing.",
          tag: "Maps",
          tool: "read_map_look_image", mcp: LOCAL_READ,
          toolOutput: { binary: { representation: "attachment", nativeImage: true } },
          display: {"verb": "Read the image of a map check"},
          relevance: [],
          effects: READ_ONLY,
          parameters: [
            pathParam("renderId", "The render's identity from the check's facts."),
            { name: "variant", in: "query", required: false, schema: { type: "string", enum: ["full", "thumbnail"] }, description: "full (the default) is the image the model was given; thumbnail is the 132 px wide derivation kept beside it." },
          ],
          responses: {
            "200": { description: "The PNG, as an attachment.", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
            "404": { description: "Evicted or gone with a restart (look_image_unavailable)." },
          },
        }),
      },
      "/api/maps/{id}/export/image": {
        post: op({
          summary: "Render a map to a PNG image",
          description:
            "Server-side image export: the map rendered by " +
            "the app's own client inside the instance's headless browser " +
            "and screenshotted at exactly the definition's pixels — the " +
            "same composition the builder's export card downloads, " +
            "pixel-faithful by construction. Takes the documented " +
            "ExportImageDefinition; answers the PNG as an attachment " +
            "(agents receive it as the base64 attachment envelope). " +
            "Bounded by the documented render budget and concurrency " +
            "cap; renders stored map state — visible layers, stored " +
            "filters — never builder-transient selections. Without a " +
            "browser on the instance the operation answers " +
            "render_unavailable; health is unaffected. A request the " +
            "page makes that outlives the per-request budget " +
            "is abandoned so the render can settle: the image is still " +
            "produced and the answer carries x-dezfil-export-abandoned " +
            "with the count and the hosts of the abandoned requests " +
            "(hosts only, never a path); the server log names the " +
            "abandonment as it happens.",
          tag: "Maps",
          tool: "export_map_image", mcp: REMOTE_READ,
          toolOutput: { binary: { representation: "attachment", nativeImage: false } },
          display: {"verb": "Rendered the map {subject} to an image", "subject": {"resource": "maps", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["definition"],
                  properties: {
                    definition: {
                      $ref: "#/components/schemas/ExportImageDefinition",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The PNG, as an attachment.",
              content: {
                "image/png": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            "400": {
              description: "Invalid definition (schema-validated).",
            },
            "503": {
              description: "No renderer browser on this instance.",
            },
          },
        }),
      },
      "/api/layers/{id}/export/{format}": {
        get: op({
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
        }),
      },
      "/api/layers/{id}/render": {
        get: op({
          summary: "Render data for a layer",
          description:
            "The layer's effective result — its SQL refined by its filters, " +
            "then aggregated by its viz (hexbin/grid cells expose value and " +
            "count). Under the render cap the response is inline GeoJSON " +
            "(mode: inline). A points-viz result over the cap is served as " +
            "vector tiles instead (mode: tiled): tiles are prepared in the " +
            "background — poll while `tiles.state` is `building`; when " +
            "`ready`, `tiles.url` is a {z}/{x}/{y} template and bounds/zoom " +
            "range describe the archive. Errored states (deleted table, " +
            "failed build, missing tiler, an aggregation over the cap) are " +
            "returned as data, not an HTTP error.",
          tag: "Layers",
          tool: "render_layer", mcp: LOCAL_READ,
          display: {"verb": "Rendered the layer {subject}", "subject": {"resource": "layers", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Layer id.")],
          responses: { "200": jsonOk("#/components/schemas/LayerRender") },
        }),
        post: op({
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
        }),
      },
      "/api/layers/{id}/slider-preview": {
        get: op({
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
        }),
      },
      "/api/layers/{id}/tiles/{z}/{x}/{y}": {
        get: op({
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
        }),
      },
      "/api/layers/{id}/fields": {
        get: op({
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
        }),
      },
      "/api/layers/{id}/fields/{field}": {
        get: op({
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
        }),
      },
      "/api/layers/{id}/fill": {
        post: op({
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
        }),
      },
      "/api/layers/{id}/scale": {
        post: op({
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
        }),
      },
      "/api/maps/{id}/publish": {
        get: op({
          summary: "The active publication's authored settings",
          description:
            "The theme default and the viewer-controls checklist for the " +
            "active publication. 204 when the map is not " +
            "published — a state, not an error. A map record carries no " +
            "publication state, so this is how an author surface reads " +
            "back what it is about to change.",
          tag: "Publish",
          tool: "get_publication_state", mcp: LOCAL_READ,
          display: {"verb": "Read the publication of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          responses: {
            "200": jsonOk(
              "#/components/schemas/PublicationState",
              "The active publication's settings.",
            ),
            "204": { description: "The map is not published." },
          },
        }),
        post: op({
          summary: "Publish a map",
          description:
            "Returns a stable, unguessable token. Idempotent while " +
            "published. The optional `theme` (\"light\" | \"dark\") " +
            "sets the published view's authored default: omitted on " +
            "a first publication it records dark (existing callers keep " +
            "their behavior); stated while already published it updates " +
            "the stored default in place — the token never changes for a " +
            "theme; omitted while published it changes nothing. The " +
            "optional `viewerControls` sets which optional " +
            "reader controls the publication exposes, on the same in-place " +
            "rule: omitted it changes nothing, and on a publication that " +
            "never stated one every control is on. Within a stated set an " +
            "omitted member reads as enabled. The two settings are " +
            "independent — stating one never rewrites the other. " +
            "Unpublishing clears both with the token.",
          tag: "Publish",
          tool: "publish_map", mcp: LOCAL_REPLACE,
          display: {"verb": "Published the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          effects: writes(resource("publications", "id")),
          confirmation: {"target": "Publish {target}?", "consequence": "Anyone with the link can view its published data.", "subject": {"path": "/api/maps/{id}", "argument": "id", "name": "name"}},
          confirm: true,
          parameters: [pathParam("id", "Map id.")],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    theme: {
                      type: "string",
                      enum: ["light", "dark"],
                      description:
                        "The authored default theme for readers" +
                        ".",
                    },
                    viewerControls: {
                      $ref: "#/components/schemas/ViewerControls",
                    },
                  },
                },
              },
            },
          },
          responses: { "201": jsonOk("#/components/schemas/PublishState", "Published.") },
        }),
        delete: op({
          summary: "Unpublish a map",
          description: "The link stops resolving immediately.",
          tag: "Publish",
          tool: "unpublish_map", mcp: LOCAL_REPLACE,
          display: {"verb": "Unpublished the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          effects: writes(resource("publications", "id")),
          confirmation: {"target": "Unpublish {target}?", "consequence": "Its published link will stop working.", "subject": {"path": "/api/maps/{id}", "argument": "id", "name": "name"}},
          confirm: true,
          parameters: [pathParam("id", "Map id.")],
          responses: { "204": { description: "Unpublished." } },
        }),
      },
      "/api/maps/{id}/published-fields": {
        get: op({
          summary: "What each layer shares when this map is published",
          description:
            "The shared-field statement: per layer, the " +
            "effective published field set — fields marked `required` are " +
            "what the published map cannot render without and publish " +
            "regardless of any list — the mode (derived | list), and every " +
            "field an explicit list could name. The publish surface " +
            "renders exactly this; the wire carries exactly what it " +
            "states. A layer whose SQL cannot resolve degrades to a " +
            "per-layer error while the rest answer.",
          tag: "Publish",
          tool: "get_published_fields", mcp: LOCAL_READ,
          display: {"verb": "Read the published fields of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          relevance: [],
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          responses: {
            "200": jsonOk("#/components/schemas/PublishedFieldsStatement"),
          },
        }),
      },
      ...TABLE_CATALOGUE_PATHS,
      ...ASSISTANT_PATHS,
      ...MCP_PATHS,
      "/api/published/{token}": {
        get: op({
          summary: "Read a published view",
          description:
            "The read-only view for a token: map, viewport, styled layers, and " +
            "render data. The only data path a published page uses. Token " +
            "ownership is checked before reuse and after assembly; responses " +
            "are private and not stored so revocation cannot be bypassed by " +
            "a browser or intermediary cache. Feature properties carry " +
            "exactly each layer's effective published field set " +
            "— the derived projection (style, label, tooltip/pop-up, " +
            "live-filter, timeline and published-widget fields) or the " +
            "author's explicit list plus the fields the map needs to " +
            "render; hidden layers contribute no feature data.",
          tag: "Publish",
          tool: "view_published_map", mcp: LOCAL_READ,
          display: {"verb": "Read a published map"},
          relevance: [],
          effects: READ_ONLY,
          parameters: [
            pathParam("token", `Publish token (${TOKEN_LENGTH} characters).`),
          ],
          responses: { "200": jsonOk("#/components/schemas/PublishedView") },
        }),
      },
      "/api/published/{token}/extent/{layerId}": {
        post: op({
          summary: "A published layer's current data extent",
          description:
            "The published half of the extent capability: the " +
            "bounding box of what the reader's current state leaves drawn. " +
            "The reader never names a field — widget selections are keyed " +
            "by widget id and resolve through the publication's stored " +
            "widgets, and the timeline window's field comes from the map's " +
            "own dock. A hidden layer or widget answers exactly as an " +
            "unknown one does. Same shared reader rate limit as the other " +
            "published lanes; `kind: \"empty\"` when nothing survives.",
          tag: "Published",
          tool: "published_layer_extent", mcp: LOCAL_READ,
          display: {"verb": "Read a published layer's extent"},
          effects: READ_ONLY,
          parameters: [
            pathParam("token", "Publish token."),
            pathParam("layerId", "Layer id within the publication."),
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    selections: {
                      type: "array",
                      items: { type: "object" },
                      description:
                        "Widget selections, keyed by widget id — the same " +
                        "shape the widget-values lane accepts.",
                    },
                    timeline: {
                      type: "object",
                      description:
                        "The reader's timeline window: `min` and `max` " +
                        "time values, either nullable for an open end. The " +
                        "field is the map's docked one, never stated here.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/LayerExtent", "The extent."),
          },
        }),
      },
      "/api/published/{token}/widget-values": {
        post: op({
          summary: "Widget values for a published view",
          description:
            "The live half of a published dashboard: the same " +
            "batched computation as the builder path, under the " +
            "published-view guarantees — the token must currently resolve, " +
            "the map must ship widgets, selections pass stored-filter " +
            "validation, and the anonymous viewer rate limit applies. " +
            "Responses are private and never stored.",
          tag: "Publish",
          tool: false,
          effects: READ_ONLY,
          parameters: [
            pathParam("token", `Publish token (${TOKEN_LENGTH} characters).`),
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    selections: {
                      $ref: "#/components/schemas/WidgetSelections",
                    },
                  },
                },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/WidgetValues") },
        }),
      },
      "/api/published/{token}/render/{layerId}": {
        post: op({
          summary: "Re-render a published computed layer under selections",
          description:
            "The published settle lane: re-render one hexbin, " +
            "grid, cluster, or heatmap layer under a reader's ephemeral " +
            "selections — cells re-bin and clusters recount, read-only, " +
            "with the same token checks and rate limit as other published " +
            "reads. Selections may only reference fields the published " +
            "surface declares — the layer's effective published field set, " +
            "or a published widget's field; anything else " +
            "answers 400 field_not_published before evaluation. Responses " +
            "carry the effective set, and a hidden layer answers 404 like " +
            "an absent one.",
          tag: "Publish",
          tool: false,
          effects: READ_ONLY,
          parameters: [
            pathParam("token", `Publish token (${TOKEN_LENGTH} characters).`),
            pathParam("layerId", "Layer id within the published map."),
          ],
          requestBody: {
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
        }),
      },
      "/api/published/{token}/tiles/{layerId}/{z}/{x}/{y}": {
        get: op({
          summary: "One vector tile of a published map's layer",
          description:
            "Read-only under the publish token, in the tile-sized anonymous " +
            "rate bucket. Only the layer's current ready server-shipped result " +
            "is eligible; revocation, deletion, replacement, an inline " +
            "transition, or a stale version returns the same clean not-found. " +
            "Use the URL template the published view reports. Current tiles " +
            "are private and must revalidate at the origin; a valid unchanged " +
            "artifact may answer conditionally. A spot the current archive " +
            "does not cover returns 204 with no body.",
          tag: "Publish",
          tool: false,
          effects: READ_ONLY,
          parameters: [
            pathParam("token", `Publish token (${TOKEN_LENGTH} characters).`),
            pathParam("layerId", "Layer id within the published map."),
            pathParam("z", "Tile zoom."),
            pathParam("x", "Tile column."),
            pathParam("y", "Tile row."),
            {
              name: "v",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Artifact version from the published view's URL template. " +
                "When supplied, it must still be current.",
            },
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
            "304": {
              description:
                "The authorized current artifact matches If-None-Match.",
            },
            "404": {
              description:
                "The publication or requested tile artifact is not current.",
              content: ERROR_RESPONSE.content,
            },
          },
        }),
      },
    },
    components: {
      schemas: {
        // Documented as a schema only: the operation that consumes it is
        // the server renderer's feature, and a tool name before that
        // operation exists would hand agents an inert schema and call it
        // capability.
        ExportImageDefinition: EXPORT_IMAGE_DEFINITION_SCHEMA,
        ...MAP_LOOK_SCHEMAS,
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
            "import would land, capped by the render cap.",
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
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", enum: Object.keys(ERROR_CATALOGUE) },
                message: { type: "string" },
              issues: { type: "array", items: { $ref: "#/components/schemas/GeometryIssue" }, description: "Geometry-choice refusal reasons, when applicable." },
                position: {
                  type: "object",
                  description:
                    "Where a sql_error sits in the submitted SQL, 1-based, " +
                    "when the engine reported it. Absent " +
                    "otherwise.",
                  properties: {
                    line: { type: "integer" },
                    column: { type: "integer" },
                  },
                  required: ["line", "column"],
                },
              },
              required: ["code", "message"],
            },
          },
        },
        Health: {
          type: "object",
          required: ["status"],
          properties: { status: { type: "string", enum: ["ready"] } },
        },
        HealthUnready: {
          type: "object",
          required: ["status", "reason"],
          properties: {
            status: { type: "string", enum: ["unready"] },
            reason: { type: "string", enum: [ERROR_CATALOGUE.internal] },
          },
        },
        DependencyDataset: {
          type: "object",
          description:
            "One dataset a map or workflow depends on — the facts both " +
            "filing checklists carry.",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            source: { type: "string" },
            rowCount: { type: "integer" },
            projectIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Every project the dataset is in; order carries no " +
                "meaning.",
            },
            geometryColumn: {
              type: ["string", "null"],
              description:
                "The geometry column; null for a non-spatial dataset.",
            },
            geometryType: {
              type: ["string", "null"],
              description:
                "The sampled geometry type; null when there is no column " +
                "or nothing was sampled — a column with no sampled type " +
                "is still spatial.",
            },
            producer: {
              type: ["object", "null"],
              description:
                "The workflow-origin recipe whose current output this " +
                "dataset is; null otherwise.",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
            },
          },
          required: [
            "id",
            "name",
            "source",
            "rowCount",
            "projectIds",
            "geometryColumn",
            "geometryType",
            "producer",
          ],
        },
        MapDependencies: {
          type: "object",
          properties: {
            datasets: {
              type: "array",
              description:
                "The distinct registered datasets the map's layers read, " +
                "alphabetical by name.",
              items: { $ref: "#/components/schemas/DependencyDataset" },
            },
          },
          required: ["datasets"],
        },
        WorkflowDependencies: {
          type: "object",
          properties: {
            datasets: {
              type: "array",
              description:
                "The distinct registered datasets the workflow reads and " +
                "writes, alphabetical by name.",
              items: { $ref: "#/components/schemas/DependencyDataset" },
            },
          },
          required: ["datasets"],
        },
        WorkspaceSettings: {
          type: "object",
          properties: {
            displayName: {
              type: "string",
              description:
                "The workspace display name; its initials badge the rail " +
                "avatar until real accounts exist.",
            },
            instanceName: {
              type: ["string", "null"],
              description:
                "The instance's optional name: shown beside " +
                "the wordmark and as the browser-title tail. Null when " +
                "the instance is unnamed.",
            },
            viewPrefs: viewPrefsSchema(),
          },
          required: ["displayName", "instanceName"],
        },
        Config: {
          type: "object",
          properties: {
            basemapUrl: {
              type: "string",
              description: "The deployment default style (override or dark).",
            },
            basemapOverrideUrl: {
              type: ["string", "null"],
              description:
                "The deployment basemap override, when set — it pins Auto " +
                "maps in both themes.",
            },
            basemaps: {
              type: "array",
              description: "The selectable basemap styles.",
              items: {
                type: "object",
                properties: {
                  key: {
                    type: "string",
                    enum: ["dark", "light", "streets", "satellite"],
                  },
                  label: { type: "string" },
                  url: { type: "string" },
                  kind: {
                    type: "string",
                    enum: ["vector", "imagery"],
                    description:
                      "Vector styles carry the toggleable content groups " +
                      "(basemapLayers); imagery is a photo — groups don't " +
                      "apply.",
                  },
                  attribution: {
                    $ref: "#/components/schemas/BasemapAttribution",
                  },
                },
              },
            },
            palettes: {
              type: "array",
              description:
                "The palette catalogue for data-driven fills, grouped for " +
                "browsing and flagged colorblind-safe where the upstream " +
                "source designates it.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  label: { type: "string" },
                  kind: { type: "string", enum: ["sequential", "categorical"] },
                  group: {
                    type: "string",
                    enum: ["sequential", "diverging", "qualitative"],
                    description:
                      "Browsing group; diverging palettes classify as kind " +
                      '"sequential" (same methods, steps, reverse).',
                  },
                  colorblindSafe: { type: "boolean" },
                  colors: { type: "array", items: { type: "string" } },
                  levels: {
                    type: "object",
                    description:
                      "Published per-class-count colors (ColorBrewer sets); " +
                      "a k-class fill uses these exact colors when present.",
                  },
                },
              },
            },
            renderCapFeatures: { type: "integer" },
            previewRows: { type: "integer" },
            geocoderConfigured: {
              type: "boolean",
              description:
                "Whether a place-search provider endpoint is configured" +
                ". The endpoint URL itself never leaves the " +
                "server.",
            },
          },
        },
        SearchResults: {
          type: "object",
          description:
            "The grouped map-search answer. `places` is " +
            "present only when asked for.",
          required: ["layers", "values", "coordinates"],
          properties: {
            layers: {
              type: "array",
              description: "Visible layers whose names match.",
              items: {
                type: "object",
                required: ["layerId", "name", "viz"],
                properties: {
                  layerId: { type: "string" },
                  name: { type: "string" },
                  viz: {
                    type: "string",
                    description: "The layer's visualization type.",
                  },
                },
              },
            },
            values: {
              type: "array",
              description:
                "Matching features, one row each, at most 20. Point " +
                "features carry `point`; lines and polygons carry an " +
                "interior `anchor` and `bounds` [minLng, minLat, maxLng, " +
                "maxLat].",
              items: {
                type: "object",
                required: ["layerId", "layerName", "field", "value"],
                properties: {
                  layerId: { type: "string" },
                  layerName: { type: "string" },
                  field: { type: "string" },
                  value: { type: "string" },
                  point: { type: "array", items: { type: "number" } },
                  anchor: { type: "array", items: { type: "number" } },
                  bounds: { type: "array", items: { type: "number" } },
                },
              },
            },
            coordinates: {
              type: "array",
              description:
                "Every plausible reading of a pasted decimal pair" +
                " — both when both are valid.",
              items: {
                type: "object",
                required: ["reading", "lat", "lng"],
                properties: {
                  reading: { type: "string", enum: ["latlon", "lonlat"] },
                  lat: { type: "number" },
                  lng: { type: "number" },
                },
              },
            },
            places: {
              type: "object",
              description:
                "The places group's answer: `ok` with results and the " +
                "provider's attribution, `unconfigured`, or `failed` with " +
                "a sanitized message (never the provider URL).",
              required: ["state"],
              properties: {
                state: {
                  type: "string",
                  enum: ["ok", "unconfigured", "failed"],
                },
                attribution: { type: ["string", "null"] },
                message: { type: "string" },
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["name", "lng", "lat"],
                    properties: {
                      name: { type: "string" },
                      context: { type: ["string", "null"] },
                      lng: { type: "number" },
                      lat: { type: "number" },
                      bounds: { type: "array", items: { type: "number" } },
                    },
                  },
                },
              },
            },
          },
        },
        OperationCatalog: {
          type: "object",
          description:
            "The verbs this instance offers, as data. An agent discovers what " +
            "it may ask the run endpoint for by reading this rather than by " +
            "knowing the verbs in advance — which is why every field a caller " +
            "needs in order to build a legal request is declared here.",
          properties: {
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  group: { type: "string" },
                  label: { type: "string" },
                  symbol: {
                    type: "string",
                    description:
                      "Glyph name a picker draws beside the label — " +
                      "presentation metadata, stable per verb, from the " +
                      "app's shared icon set.",
                  },
                  blurb: {
                    type: "string",
                    description:
                      "One plain-text line for pickers. `description` is " +
                      "the reference text; this is the working surface's " +
                      "sentence.",
                  },
                  description: { type: "string" },
                  inputs: {
                    type: "array",
                    description:
                      "The datasets this verb takes and what each is for. A " +
                      "verb with two inputs has two that are not " +
                      "interchangeable — a spatial join's left and right mean " +
                      "different things, and the output's geometry comes " +
                      "from one of them. A verb that declares none takes its " +
                      "input from whatever its own SQL names, which is a " +
                      "different thing from taking no input at all.",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        label: { type: "string" },
                        description: { type: "string" },
                        accepts: {
                          type: "array",
                          items: {
                            type: "string",
                            enum: ["any", "none", "point", "line", "polygon"],
                          },
                          description:
                            'Geometry classes this particular input accepts. ' +
                            '"none" is the opposite of "any": it admits only a ' +
                            "table without geometry, which is what a verb that " +
                            "writes a geometry column onto every row takes.",
                        },
                        required: { type: "boolean" },
                      },
                    },
                  },
                  accepts: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["any", "none", "point", "line", "polygon"],
                    },
                    description:
                      "Input geometry classes the operation accepts overall; " +
                      '"any" includes a table with no geometry, and "none" ' +
                      "admits only one.",
                  },
                  requires: {
                    type: "array",
                    items: { type: "string", enum: ["geocoder", "isochrone"] },
                    description:
                      "What this instance must be configured with for the " +
                      "verb to run at all. A verb that declares none always " +
                      "runs.",
                  },
                  availability: {
                    type: "object",
                    description:
                      "Whether *this* instance can run the verb, resolved when " +
                      "the catalog is served rather than declared — an " +
                      "operator who configures a provider changes the answer " +
                      "without changing a verb. A verb with no requirement " +
                      "answers available.",
                    properties: {
                      available: { type: "boolean" },
                      reason: {
                        type: ["string", "null"],
                        description:
                          "Why not, when it cannot — one sentence a reader " +
                          "can act on, naming the setting that is missing.",
                      },
                    },
                  },
                  outputGeometry: {
                    type: "object",
                    description:
                      "Where the result's geometry comes from. A verb that " +
                      "fixes its class regardless of input declares it; one " +
                      "that passes geometry through names the input it comes " +
                      "from; one whose result must be inspected says so.",
                    properties: {
                      kind: {
                        type: "string",
                        enum: ["probed", "none", "from_input", "fixed"],
                      },
                      input: { type: "string" },
                      geometry: {
                        type: "string",
                        enum: ["point", "line", "polygon"],
                      },
                    },
                  },
                  parameters: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        min: { type: "number", description: "Hard lower bound, where the verb has one." },
                        max: { type: "number", description: "Hard upper bound, where the verb has one." },
                        name: { type: "string" },
                        type: {
                          type: "string",
                          enum: [
                            "string",
                            "number",
                            "boolean",
                            "enum",
                            "enum_list",
                            "field",
                            "column_list",
                            "field_list",
                            "number_list",
                          ],
                          description:
                            "`enum` is one value from `options`; `enum_list` " +
                            "is several, as a list. They are distinct " +
                            "because a caller told `enum` where a list is " +
                            "required has been given the wrong shape. " +
                            "`field` is one column of the named input; " +
                            "`column_list` is several columns, as names; " +
                            "`field_list` is several **aggregate " +
                            "specifications** — `{aggregate, field, as}` — " +
                            "and sending one shape where the other is " +
                            "expected is refused.",
                        },
                        required: { type: "boolean" },
                        description: { type: "string" },
                        options: {
                          type: "array",
                          items: { type: "string" },
                          description:
                            "The permitted values for an enum or enum list, " +
                            "fixed by the operation's own contract rather " +
                            "than by whatever the engine happens to offer. " +
                            "On a `field_list` these are the aggregates that " +
                            "parameter accepts, which differ between verbs.",
                        },
                        aliasable: {
                          type: "boolean",
                          description:
                            "Whether a carried value may be given a name of " +
                            "its own. A summary's aggregates cannot, and an " +
                            "editor offering the field would produce a name " +
                            "the operation ignores.",
                        },
                        requiredWhen: {
                          type: "object",
                          description:
                            "What makes this parameter required, when it is " +
                            "not always — a distance is needed only for a " +
                            "within-distance relationship. Declared so a " +
                            "caller knows before it sends rather than after " +
                            "the refusal.",
                          properties: {
                            parameter: { type: "string" },
                            equals: { type: "string" },
                          },
                        },
                        relevantWhen: {
                          type: "object",
                          description:
                            "When this parameter is part of the question at " +
                            "all — absent means always; present, it only " +
                            "applies while the named parameter holds one of " +
                            "these values. A distance is no part of an " +
                            "\"intersects\" question. Distinct from " +
                            "requiredWhen: a parameter can be used without " +
                            "being required. A value sent for an " +
                            "inapplicable parameter is ignored or refused by " +
                            "the operation's own admission, so callers " +
                            "should omit it.",
                          properties: {
                            parameter: { type: "string" },
                            oneOf: { type: "array", items: { type: "string" } },
                          },
                        },
                        ofInput: {
                          type: "string",
                          description:
                            "Which input a field parameter names a column of.",
                        },
                        fieldType: {
                          type: "string",
                          enum: ["text", "number"],
                          description:
                            "The kind of column a field parameter may name, " +
                            "when the verb needs one kind. Declared so a " +
                            "caller offers or sends a column that can work " +
                            "rather than learning from a refusal; admission " +
                            "checks the same rule.",
                        },
                        minItems: {
                          type: "number",
                          description:
                            "For a number_list: the fewest items the list " +
                            "takes.",
                        },
                        maxItems: {
                          type: "number",
                          description:
                            "For a number_list: the most items the list " +
                            "takes — the isochrone's four bands is the " +
                            "protocol's own maximum.",
                        },
                        itemMin: {
                          type: "number",
                          description:
                            "For a number_list: the floor every item must " +
                            "clear.",
                        },
                        itemInteger: {
                          type: "boolean",
                          description:
                            "For a number_list: items must be whole numbers.",
                        },
                        itemsUnique: {
                          type: "boolean",
                          description:
                            "For a number_list: duplicate items are refused " +
                            "— each band is asked once.",
                        },
                        unit: {
                          type: "string",
                          enum: ["metres", "minutes"],
                          description:
                            "Present when the value is not a bare number: " +
                            "`metres` is a **ground measurement** — metres " +
                            "on the earth, at the latitude the data " +
                            "occupies, never degrees and never metres on a " +
                            "map projection; a caller that ignores this and " +
                            "sends the geometry's own units gets a buffer " +
                            "five hundred degrees wide. `minutes` is travel " +
                            "time: the number the user typed is the " +
                            "number on the wire, no conversion exists.",
                        },
                        default: {
                          description:
                            "The value used when the parameter is omitted.",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        OperationMeasurement: {
          type: "object",
          description:
            "Where a run measured. A buffer whose record does not name " +
            "its measurement CRS is not reproducible — the same operation " +
            "with the same parameters can produce a different geometry under " +
            "a later strategy, and nothing would explain the difference.",
          properties: {
            crs: {
              type: "object",
              description:
                "The CRS each kind of measurement happened in, keyed by kind. " +
                "A distance is measured in a projection local to the data's " +
                "own extent; an area in a global equal-area projection.",
              additionalProperties: { type: "string" },
            },
            fallback: {
              type: "boolean",
              description:
                "True when a measurement was made in a global projection " +
                "rather than a local one, so a number measured globally is " +
                "never read back as one measured locally.",
            },
            assumedCrs: {
              type: "array",
              items: { type: "string" },
              description:
                "Inputs whose WGS84 was assumed rather than declared. The " +
                "measurement is only as trustworthy as that assumption.",
            },
          },
        },
        OperationDryRun: {
          type: "object",
          description:
            "The answer to dryRun: what the operation would produce, with " +
            "nothing written.",
          properties: {
            operation: { type: "string" },
            warnings: {
              type: "array",
              items: { type: "string" },
              description:
                "Non-fatal facts to read before committing to the run — " +
                "today, that a measured input's coordinate system was " +
                "assumed rather than declared. Said here so a caller " +
                "learns it *before* running, not after.",
            },
            measurement: { $ref: "#/components/schemas/OperationMeasurement" },
            dryRun: {
              type: "object",
              properties: {
                rowCount: { type: "integer" },
                geometryColumn: { type: ["string", "null"] },
                geometryType: {
                  type: ["string", "null"],
                  description:
                    "The class the registered dataset would carry, in the " +
                    "same words an imported table holding that geometry does.",
                },
                geometry: {
                  type: "string",
                  enum: ["none", "undetermined", "classified"],
                  description:
                    "Which of the three answers this is. 'none' — the result " +
                    "has no geometry column and would be a table, not a " +
                    "mappable layer. 'undetermined' — it has one but no geometries to classify. " +
                    "'classified' — geometryType names its " +
                    "class. A null geometryType alone cannot tell the first " +
                    "two apart.",
                },
              },
            },
          },
        },
        OperationRun: {
          type: "object",
          description:
            "One run of an operation. The same shape in every state, so a " +
            "queued run and a finished one are read the same way.\n\n" +
            "Fields that have not happened yet are absent rather than " +
            "present and empty: a queued run carries no startedAt, and a " +
            "run that has not succeeded carries no output. There is " +
            "deliberately no completion percentage — the engine's own " +
            "progress signal is unreachable from the hardened query " +
            "instance, and it would describe one statement of a run made " +
            "of several. Show elapsed time from startedAt instead.",
          properties: {
            id: {
              type: "string",
              description: "Identifies this run, distinct from its output.",
            },
            operation: { type: "string" },
            state: {
              type: "string",
              enum: ["queued", "running", "succeeded", "failed", "cancelled"],
              description:
                "The last three are terminal and never change again. A " +
                "cancelled run carries no error: the user's own choice is " +
                "not a fault.",
            },
            warnings: {
              type: "array",
              items: { type: "string" },
              description:
                "Non-fatal facts to read before trusting the answer — today, " +
                "that a measured input's coordinate system was assumed " +
                "rather than declared. Present on the answer that accepts a " +
                "run; the durable record is the output's own provenance, so " +
                "a polled run does not repeat it.",
            },
            subject: {
              type: "object",
              description:
                "What groups this run with others in history. 'client' " +
                "when the caller supplied the identity, 'run' when the " +
                "run is its own subject.",
              properties: {
                kind: {
                  type: "string",
                  enum: ["run", "client", "step"],
                  // `step` is not one a caller can send: it is what keeps a
                  // recipe step's history its own.
                },
                id: { type: "string" },
              },
            },
            parameters: {
              type: "object",
              description: "The parameters this run was accepted with.",
            },
            acceptedAt: { type: "string" },
            startedAt: {
              type: "string",
              description: "Absent until the run leaves the queue.",
            },
            finishedAt: {
              type: "string",
              description: "Absent until the run reaches a terminal state.",
            },
            output: {
              type: "object",
              description:
                "The dataset the run wrote, by id and by name. Present " +
                "only on a succeeded run.",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
            },
            disclosure: {
              type: "object",
              description:
                "What this run asked, for a run whose answers came from a " +
                "**provider** rather than the engine — the endpoint's " +
                "host and path, the parameters that affected the answers, " +
                "the address-normalization version, and how many distinct " +
                "questions were answered from the cache and how many from " +
                "the wire. It stands in place of the SQL an in-engine run " +
                "records, and it belongs to *this* run: a later re-run of " +
                "the same step publishes its own. The endpoint's query " +
                "string, where a key travels, is never included. Absent on " +
                "a run that asked nobody.",
              additionalProperties: true,
            },
            error: {
              type: "object",
              description: "Present only on a failed run.",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
        OperationRunEnvelope: {
          type: "object",
          properties: { run: { $ref: "#/components/schemas/OperationRun" } },
        },
        OperationRunList: {
          type: "object",
          properties: {
            runs: {
              type: "array",
              items: { $ref: "#/components/schemas/OperationRun" },
            },
          },
        },
        StaleCause: {
          type: "object",
          description:
            "Why a step's output no longer reflects what it was made from. " +
            "**Every active cause is reported**, each naming the input it " +
            "came from: a step can read a refreshed table *and* sit " +
            "downstream of a re-run step at once, and discarding one to " +
            "show the other would leave this unable to say why.",
          properties: {
            reason: {
              type: "string",
              enum: ["source_changed", "upstream_stale", "upstream_re_ran"],
            },
            tableId: { type: "string" },
            tableName: { type: "string" },
            producedByStepId: {
              type: "string",
              description: "The step that produces that table, when one does.",
            },
          },
        },
        RecipeStep: {
          type: "object",
          properties: {
            id: { type: "string" },
            recipeId: { type: "string" },
            ordinal: { type: "integer" },
            operation: { type: "string" },
            parameters: {
              type: "object",
              description:
                "What the step means now — what its output was produced " +
                "from. Non-scalar parameters are kept as sent.",
            },
            summary: {
              type: "string",
              description:
                "One line describing what this step does, composed from the " +
                "operation and its active parameters — \"500 m around " +
                "stations\". Served so every surface and every agent reads " +
                "the same sentence rather than composing its own; it " +
                "describes what the step means now, never a proposal " +
                "awaiting a run.",
            },
            proposedParameters: {
              type: ["object", "null"],
              description:
                "An edit awaiting a successful run; null when there is none.",
            },
            output: {
              type: ["object", "null"],
              description: "The dataset this step owns, once it has produced one.",
              properties: {
                id: { type: "string" },
                name: { type: ["string", "null"] },
              },
            },
            condition: {
              type: "string",
              enum: ["broken", "output_missing", "stale", "never_run", "current"],
              description:
                "The first condition true of it, in the order broken, " +
                "output missing, stale, never run, current — un-runnable " +
                "before un-current, because offering a re-run that cannot " +
                "succeed tells the user the wrong thing.",
            },
            conditions: {
              type: "array",
              items: { type: "string" },
              description:
                "**Every** condition true of it. Conditions coexist: a step " +
                "can have lost both an input and its output.",
            },
            causes: {
              type: "array",
              items: { $ref: "#/components/schemas/StaleCause" },
            },
            missingInputs: {
              type: "array",
              description:
                "What it lost, when it is broken — with the id and name it " +
                "recorded, which is how the row explains itself after a " +
                "deletion. `throughStepId` is set when the break arrived " +
                "from a producer upstream rather than from this step's own " +
                "input.",
              items: {
                type: "object",
                properties: {
                  tableId: { type: "string" },
                  tableName: { type: "string" },
                  throughStepId: { type: "string" },
                },
              },
            },
            origin: {
              type: ["object", "null"],
              description:
                "Where a layer-authored step's SQL came from, including " +
                "`substitutionNote` when the layer aggregated and the step " +
                "took the rows behind the cells instead.",
            },
            inputs: {
              type: "array",
              description:
                "The tables this step read when it last published — from " +
                "the parse of the SQL that ran, never a scan of its text.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                },
              },
            },
            reads: {
              type: "array",
              items: { type: "string" },
              description:
                "What the step would read on its next run: its pending " +
                "definition's reads when it holds one, its active definition's " +
                "otherwise — named inputs, or the tables its SQL names — " +
                "before any run and whether or not those tables exist. " +
                "Present tense; `inputs` is the recorded past.",
            },
            latestAttempt: {
              oneOf: [
                { $ref: "#/components/schemas/OperationRun" },
                { type: "null" },
              ],
              description:
                "Its most recent run, in one of the five job states. Read " +
                "together with the condition and never instead of it.",
            },
            lastSuccessAt: { type: ["string", "null"] },
          },
        },
        Recipe: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            origin: {
              type: "string",
              enum: ["workflow", "builder"],
              description:
                "Which surface made it: the workflows page lists `workflow`; " +
                "the builder's one-step Tools make `builder`. Fixed at creation.",
            },
            projectId: {
              type: ["string", "null"],
              description:
                "The project this workflow is in; null = not " +
                "in a project.",
            },
            createdAt: { type: "string" },
            updatedAt: {
              type: "string",
              description:
                "When it was last edited: rename, or a step added, edited, " +
                "reordered or removed. A run is not an edit, and neither is " +
                "a refused change. Strictly increasing.",
            },
            summary: { $ref: "#/components/schemas/RecipeSummary" },
            steps: {
              type: "array",
              items: { $ref: "#/components/schemas/RecipeStep" },
            },
          },
        },
        RecipeSummary: {
          type: "object",
          description:
            "The recipe's one-line state, computed by the server so the " +
            "workflows page and an agent read the same classification. The " +
            "first status that applies wins; a step in more than one " +
            "condition counts once, in the status shown.",
          properties: {
            nodes: { type: "integer", description: "Steps in the recipe." },
            sources: {
              type: "integer",
              description:
                "Distinct tables read that no step of this recipe produces.",
            },
            liveOutputs: {
              type: "integer",
              description:
                "Outputs whose dataset currently exists — what deleting the " +
                "recipe leaves behind.",
            },
            status: {
              type: "string",
              enum: [
                "empty",
                "cannot_run",
                "in_progress",
                "failed",
                "run_again",
                "never_run",
                "partly_never_run",
                "up_to_date",
              ],
              description:
                "In precedence: `empty` (no steps); `cannot_run` (a step is " +
                "broken); `in_progress` (a latest attempt queued or running); " +
                "`failed` (a latest attempt failed); `run_again` (an output " +
                "deleted or stale, or a pending edit); `never_run` (no step " +
                "has an output); `partly_never_run` (some have none); " +
                "`up_to_date`. A cancelled attempt alone changes nothing.",
            },
            count: {
              type: "integer",
              description:
                "How many steps the status counts; 0 for empty and up to date.",
            },
          },
        },
        RecipeEnvelope: {
          type: "object",
          properties: { recipe: { $ref: "#/components/schemas/Recipe" } },
        },
        RecipeList: {
          type: "object",
          properties: {
            recipes: {
              type: "array",
              items: { $ref: "#/components/schemas/Recipe" },
            },
          },
        },
        RecipeStepEnvelope: {
          type: "object",
          properties: { step: { $ref: "#/components/schemas/RecipeStep" } },
        },
        RecipeStepEdited: {
          type: "object",
          properties: {
            step: { $ref: "#/components/schemas/RecipeStep" },
            applied: {
              type: "string",
              enum: ["active", "proposed"],
              description:
                "`active` changed what the step means; `proposed` is " +
                "waiting on a successful run of it.",
            },
          },
        },
        RecipeStepRemoved: {
          type: "object",
          properties: {
            removed: { type: "string" },
            output: {
              type: ["object", "null"],
              description: "The step's output, by its recorded identity; null for a step that declared none.",
              properties: {
                name: { type: "string" },
                state: {
                  type: "string",
                  enum: ["exists", "deleted", "never"],
                  description:
                    "`exists`: the dataset remains; `deleted`: it was produced " +
                    "but has since been deleted; `never`: the step never produced one.",
                },
              },
            },
            readers: {
              type: "array",
              description: "The recipe's other steps whose present reads name the output.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  operation: { type: "string" },
                  label: { type: "string" },
                },
              },
            },
            outputsRemain: { type: "boolean", description: "True only when the dataset exists." },
            message: { type: "string" },
          },
        },
        RecipeStepDiscarded: {
          type: "object",
          properties: {
            step: { $ref: "#/components/schemas/RecipeStep" },
            discarded: {
              type: "boolean",
              description: "Whether a pending edit was there to discard.",
            },
          },
        },
        LayoutPosition: {
          type: "object",
          description: "Canvas units at the canvas's natural zoom.",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
        },
        LayoutNote: {
          type: "object",
          description:
            "A layout-only annotation: no reads, no output, no state, no " +
            "place in a run. Nothing in the recipe refers to it.",
          properties: {
            id: {
              type: "string",
              description: "Chosen by the writer; unique within the document.",
            },
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number", description: "Positive." },
            h: { type: "number", description: "Positive." },
            color: {
              type: "string",
              enum: ["yellow", "green", "blue", "pink", "purple", "grey"],
            },
            text: {
              type: "string",
              description:
                "Markdown, at most 4,000 characters, stored verbatim. The " +
                "canvas reads a `label:` line in a leading `---` block as " +
                "the note's label; the API interprets nothing.",
            },
          },
          required: ["id", "x", "y", "w", "h", "color", "text"],
        },
        RecipeLayoutInput: {
          type: "object",
          description:
            "The whole document. An absent map or list is the empty one.",
          properties: {
            steps: {
              type: "object",
              description: "A position per step, keyed by step id.",
              maxProperties: 1_000,
              propertyNames: { maxLength: 1_000 },
              additionalProperties: { $ref: "#/components/schemas/LayoutPosition" },
            },
            sources: {
              type: "object",
              description:
                "A position per source, keyed by table name. A source may " +
                "be positioned that no step reads yet: a loose table on the " +
                "canvas lives only here.",
              maxProperties: 1_000,
              propertyNames: { maxLength: 1_000 },
              additionalProperties: { $ref: "#/components/schemas/LayoutPosition" },
            },
            notes: {
              type: "array",
              description: "At most 100, in the writer's order.",
              items: { $ref: "#/components/schemas/LayoutNote" },
            },
          },
        },
        RecipeLayout: {
          allOf: [
            { $ref: "#/components/schemas/RecipeLayoutInput" },
            {
              type: "object",
              properties: {
                updatedAt: {
                  type: ["string", "null"],
                  description:
                    "When the document was last written; null for one " +
                    "never written.",
                },
              },
            },
          ],
        },
        RecipeLayoutEnvelope: {
          type: "object",
          properties: { layout: { $ref: "#/components/schemas/RecipeLayout" } },
        },
        RecipeDeleted: {
          type: "object",
          properties: {
            deleted: { type: "string" },
            outputsRemain: {
              type: "boolean",
              description:
                "Always true: a recipe's datasets survive its deletion.",
            },
            message: { type: "string" },
          },
        },
        RecipeRunAttempt: {
          type: "object",
          description:
            "What became of a member's attempt: the job's state, " +
            "error, times and output, composed from the live job while it is " +
            "in flight — so `queued` is told from `running` — and kept with " +
            "the run once it settles, so the run still says why a member " +
            "failed after the node's own history is pruned. A member never " +
            "attempted (`not_run`, or refused at admission) has none.",
          properties: {
            state: {
              type: "string",
              enum: ["queued", "running", "succeeded", "failed", "cancelled"],
            },
            error: {
              type: ["object", "null"],
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
            acceptedAt: { type: "string" },
            startedAt: { type: ["string", "null"] },
            finishedAt: { type: ["string", "null"] },
            output: {
              type: ["object", "null"],
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
          },
        },
        RecipeRunMember: {
          type: "object",
          properties: {
            stepId: { type: "string" },
            ordinal: { type: "integer" },
            operation: {
              type: ["string", "null"],
              description:
                "The node's operation when the run was planned, kept with the " +
                "run after the node is removed.",
            },
            name: {
              type: ["string", "null"],
              description:
                "The name the node was called by when the run was planned — " +
                "its dataset's, or the one it declared — kept after the node " +
                "is removed.",
            },
            output: {
              type: ["object", "null"],
              description: "The dataset this member published; null until it has.",
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
            attempt: {
              oneOf: [{ $ref: "#/components/schemas/RecipeRunAttempt" }, { type: "null" }],
            },
            state: {
              type: "string",
              enum: ["pending", "running", "succeeded", "failed", "not_run"],
              description:
                "`not_run` is the member's own condition and never a job " +
                "state: nothing was minted for it.",
            },
            jobId: {
              type: ["string", "null"],
              description: "The operation run this member minted; null for `not_run`.",
            },
            stoppedBy: {
              type: ["string", "null"],
              description:
                "What stopped it — the step id of the member whose failure " +
                "blocked it, or a coded reason.",
            },
            stoppedReason: {
              type: ["string", "null"],
              description:
                "The server's own sentence for that stop, where there is " +
                "one — for a member refused before any job existed, this is " +
                "the only field that names *which* input was missing or " +
                "which parameter was out of range. `stoppedBy` carries a " +
                "code, a blocking step id or `cancelled`, none of which a " +
                "reader can act on by itself.",
            },
          },
        },
        RecipeRun: {
          type: "object",
          description:
            "A recipe run is **not** an operation run. An operation run " +
            "names exactly one output; this may produce several, none, or a " +
            "mix of succeeded and never-attempted members — so it has its " +
            "own outcome and *contains* runs rather than being one.",
          properties: {
            id: { type: "string" },
            recipeId: { type: "string" },
            kind: { type: "string", enum: ["run_all", "from_step", "single"] },
            outcome: {
              type: ["string", "null"],
              enum: [
                "completed",
                "partly_completed",
                "failed",
                "cancelled",
                "interrupted",
                null,
              ],
              description:
                "Null while it is still going. `interrupted` is how a run " +
                "the server stopped mid-flight settles — it always reaches " +
                "a terminal outcome, and nothing is resumed.",
            },
            cancelled: { type: "boolean" },
            startedAt: { type: "string" },
            finishedAt: { type: ["string", "null"] },
            members: {
              type: "array",
              items: { $ref: "#/components/schemas/RecipeRunMember" },
            },
            outputs: {
              type: "array",
              description: "Every dataset this run produced.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                },
              },
            },
          },
        },
        RecipeRunEnvelope: {
          type: "object",
          properties: { run: { $ref: "#/components/schemas/RecipeRun" } },
        },
        RecipeRunList: {
          type: "object",
          properties: {
            runs: {
              type: "array",
              items: { $ref: "#/components/schemas/RecipeRun" },
            },
          },
        },
        RecipeRunPlan: {
          type: "object",
          properties: {
            plan: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["run_all", "from_step", "single"] },
                wide: {
                  type: "boolean",
                  description:
                    "True when this would carry other steps with it. The " +
                    "`when_wide` confirmation is about exactly this.",
                },
                members: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        ...GEOMETRY_EVIDENCE_SCHEMAS,
        ...GEOMETRY_RESOURCE_SCHEMAS,
        Table: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            sourceFilename: {
              type: ["string", "null"],
              description:
                "The file this table arrived as. Null for a derived " +
                "table, whose output never was a file.",
            },
            format: {
              type: "string",
              enum: [
                "geoparquet",
                "geojson",
                "csv",
                "shapefile",
                "geopackage",
                "kml",
              ],
            },
            geometryColumn: { type: ["string", "null"] },
            geometryType: { type: ["string", "null"] },
            geometryRecord: {
              anyOf: [{ $ref: "#/components/schemas/GeometryRecord" }, { type: "null" }],
              description: "Applied automatic CSV recognition or a manual file/URL geometry choice. Null after clear or recognition without a choice; legacy absence is preserved until geometry is set.",
            },
            geometryCandidates: {
              type: "array",
              items: { $ref: "#/components/schemas/GeometryCandidate" },
              description: "Automatic CSV recognition evidence. Manual geometry edits clear this stored sample; GET geometry recomputes current candidates. Legacy absence is preserved until a correction.",
            },
            crsAssumed: { type: "boolean" },
            headerSuspect: {
              type: "boolean",
              description:
                "True when a CSV's detected column names betrayed a " +
                "broken read: a name containing a comma (the header was " +
                "never split), or most names numeric or blank (the first " +
                "data row was taken as the header). Advisory only — the " +
                "import succeeded and nothing is blocked. Always false " +
                "for non-CSV sources and derived tables; a refresh " +
                "recomputes it.",
            },
            rowCount: { type: "integer" },
            createdAt: { type: "string" },
            source: {
              type: "string",
              enum: [
                "upload",
                "url",
                "overture",
                "osm",
                "postgis",
                "operation",
                "sketch",
              ],
              description:
                "Which source created the table; " +
                '"operation" for a table an operation produced; ' +
                '"sketch" for a table drawn on a map — its ' +
                "sourceParams carry mapId, mapName and layerId.",
            },
            sourceParams: {
              type: ["object", "null"],
              description:
                "Parameters that re-run the import (e.g. { url }); null " +
                "for single-file uploads. Container-format tables " +
                "also record { layer, group? } — the source layer and, " +
                "for multi-layer imports, the shared group id; for " +
                "uploads these describe provenance only, since uploads " +
                "are never refreshable. For a derived table this " +
                "records the operation that produced it (`operation`, the " +
                "catalogue's identifier), its parameters, the SQL that ran " +
                "(`sql`), its inputs by id as well as by name (`inputs`), " +
                "and when it ran (`ranAt`); the inspection resolves those " +
                "inputs into its own `inputs` field. A table produced by an " +
                "operation that asked a **provider** carries a " +
                "`disclosure` — the request it made: the endpoint's host " +
                "and path (`endpoint`, null when none was recorded) and the " +
                "request's other recorded facts, each operation's own — " +
                "and **no `sql` at all**: its statement names a private " +
                "staging path, and an absence is a better contract than a " +
                "redaction that must never miss. The disclosure's endpoint " +
                "is host and path only; the query string, where a key " +
                "travels, is never recorded anywhere. A reader may rely on " +
                "these fields as the durable provenance of the dataset: the " +
                "workflow canvas's Provenance tab shows them and " +
                "recomputes nothing.",
            },
            importedAt: {
              type: ["string", "null"],
              description:
                "When this table's data was last produced — the import's " +
                "last run, or for a derived table the run that " +
                "wrote it.",
            },
            inputs: {
              type: ["array", "null"],
              description:
                "For a derived table: the inputs its run recorded, " +
                "resolved by the id each was recorded under. An input whose " +
                "id no longer exists reads as missing — never as whatever " +
                "now carries its name.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: {
                    type: "string",
                    description: "The name recorded when the run happened.",
                  },
                  currentName: {
                    type: "string",
                    description: "The name that id carries now, if it exists.",
                  },
                  missing: { type: "boolean" },
                  nameReclaimed: {
                    type: "boolean",
                    description:
                      "The recorded name now belongs to a different table.",
                  },
                },
              },
            },
            sizeBytes: {
              type: ["integer", "null"],
              description:
                "Size of the stored GeoParquet artifact in bytes; " +
                "present on listings and inspections, null if the file is " +
                "missing.",
            },
            projectIds: {
              type: "array",
              items: { type: "string" },
              description:
                "The projects this dataset is in; empty = not " +
                "in a project. A dataset can be in several; the order " +
                "carries no meaning.",
            },
          },
        },
        TableList: {
          type: "array",
          items: { $ref: "#/components/schemas/Table" },
        },
        ImportResult: {
          description:
            "An import answer. Single-table formats answer with the " +
            "created table alone. Container formats (Shapefile zip, " +
            "GeoPackage, KML/KMZ) can hold several layers: the answer is " +
            "then the first created table plus `tables` — every table the " +
            "import created, one per spatial layer — and `skipped`, the " +
            "members that did not become tables and why.",
          allOf: [
            { $ref: "#/components/schemas/Table" },
            {
              type: "object",
              properties: {
                tables: { $ref: "#/components/schemas/TableList" },
                skipped: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      layer: { type: "string" },
                      reason: { type: "string" },
                    },
                  },
                },
              },
            },
          ],
        },
        PgConnection: {
          type: "object",
          description:
            "A saved PostGIS connection. Passwords are write-only and " +
            "never appear here.",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            host: { type: "string" },
            port: { type: "integer" },
            database: { type: "string" },
            username: { type: "string" },
            ssl: { type: "boolean" },
            createdAt: { type: "string" },
            status: {
              type: "string",
              enum: [
                "connected",
                "failing",
                "no_postgis",
                "not_checked_lately",
                "never_checked",
              ],
              description:
                "Derived from the persisted last use. Connected becomes " +
                "not_checked_lately at seven days.",
            },
            lastCheckedAt: { type: ["string", "null"] },
            lastCheckError: {
              type: ["string", "null"],
              description: "A credential-free failure sentence.",
            },
            serverVersion: { type: ["string", "null"] },
            postgisVersion: {
              type: ["string", "null"],
              description:
                "The most recently observed PostGIS version, or null when " +
                "none has been observed or PostGIS was absent.",
            },
          },
        },
        PgConnectionList: {
          type: "array",
          items: { $ref: "#/components/schemas/PgConnection" },
        },
        TableInspection: {
          allOf: [
            { $ref: "#/components/schemas/Table" },
            {
              type: "object",
              properties: {
                columns: { $ref: "#/components/schemas/ColumnList" },
                preview: { type: "array", items: { type: "object" } },
              },
            },
          ],
        },
        ColumnList: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
            },
          },
        },
        QueryResult: {
          type: "object",
          properties: {
            columns: { $ref: "#/components/schemas/ColumnList" },
            rowCount: { type: "integer" },
            preview: { type: "array", items: { type: "object" } },
            previewTruncated: { type: "boolean" },
            runtimeMs: { type: "integer" },
          },
        },
        LegendCorner: {
          type: ["string", "null"],
          enum: ["top-left", "top-right", "bottom-left", "bottom-right", null],
          description:
            "Where the map legend sits, on the builder canvas " +
            "and the published view alike. Null means bottom-left — the " +
            "historical position. Overlays sharing a corner stack.",
        },
        LegendOrder: {
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "The manual legend arrangement: layer ids in " +
            "legend order, top first. Null means automatic — the legend " +
            "follows the layer panel's top-to-bottom order. A write must " +
            "list exactly the map's current layer ids (no misses, no " +
            "strangers, no doubles) or null to return to automatic; " +
            "anything else is rejected unchanged. Layers added later " +
            "enter at the top until the next manual write.",
        },
        BasemapAttribution: {
          type: "array",
          description:
            "The active basemap's credit lines, rendered on the " +
            "builder canvas and the published view; a line with an href " +
            "renders as a link.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              href: { type: "string" },
            },
            required: ["label"],
          },
        },
        CustomBasemap: {
          type: ["object", "null"],
          description:
            "A per-map custom basemap style: the MapLibre " +
            "style URL, its optional display name, and the attribution " +
            "snapshot captured server-side at save time — the credit that " +
            "stays truthful when the style itself cannot be read later.",
          properties: {
            url: { type: "string" },
            name: { type: ["string", "null"] },
            attribution: { $ref: "#/components/schemas/BasemapAttribution" },
          },
          required: ["url", "name", "attribution"],
        },
        SanitizedIcon: {
          type: "object",
          description:
            "The custom-icon sanitizer's answer: the accepted " +
            "markup (byte-identical to the input when nothing needed " +
            "removing), whether anything changed, the bounded drop report, " +
            "and the aspect ratio the renderer derives its raster box " +
            "from.",
          properties: {
            svg: { type: "string" },
            changed: { type: "boolean" },
            dropped: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: {
                    type: "string",
                    enum: ["element", "attribute", "declaration"],
                  },
                  name: { type: "string" },
                },
                required: ["kind", "name"],
              },
            },
            aspect: { type: "number" },
          },
          required: ["svg", "changed", "dropped", "aspect"],
        },
        StyleInspection: {
          type: "object",
          description:
            "The advisory verdict on a custom basemap style URL" +
            ". valid carries the style's name, layer and source " +
            "counts, and normalized attribution; the other verdicts carry " +
            "a worded detail. unreachable and blocked can still be saved " +
            "with force — every reader's browser fetches the style itself.",
          properties: {
            verdict: {
              type: "string",
              enum: ["valid", "not_style", "unreachable", "blocked"],
            },
            name: { type: ["string", "null"] },
            layerCount: { type: "number" },
            sourceCount: { type: "number" },
            attribution: { $ref: "#/components/schemas/BasemapAttribution" },
            detail: { type: "string" },
          },
          required: ["verdict"],
        },
        BasemapLayers: {
          type: ["object", "null"],
          description:
            "Per-group basemap visibility: labels, roads, " +
            "borders, buildings, water, land. A missing group is visible; " +
            "false hides that group on the builder canvas and the published " +
            "view, on every vector basemap style — imagery (satellite) has " +
            "no groups, so toggles are inert there and the imagery itself " +
            "is never hidden. Null means everything is visible.",
          properties: {
            labels: { type: "boolean" },
            roads: { type: "boolean" },
            borders: { type: "boolean" },
            buildings: { type: "boolean" },
            water: { type: "boolean" },
            land: { type: "boolean" },
          },
        },
        MapNote: {
          type: ["object", "null"],
          description:
            "The map's one optional info box, shown in a map " +
            "corner on the builder canvas and the published view. The body " +
            "supports a safe formatting subset — bold, italic, links, " +
            "lists, paragraphs; raw HTML renders as plain text and links " +
            "open in a new tab. Null means no box.",
          properties: {
            title: {
              type: ["string", "null"],
              description: "Optional heading (max 120 characters).",
            },
            body: {
              type: "string",
              description: "The text (max 4,000 characters).",
            },
            corner: {
              type: "string",
              enum: ["top-left", "top-right", "bottom-left", "bottom-right"],
              description: "Placement; defaults to top-right.",
            },
          },
          required: ["body"],
        },
        Viewport: {
          type: "object",
          description:
            `The map camera: pitch ${CAMERA_BOUNDS.pitch.minimum} to ${CAMERA_BOUNDS.pitch.maximum} degrees, ` +
            `latitude ${CAMERA_BOUNDS.lat.minimum} to ${CAMERA_BOUNDS.lat.maximum} degrees, ` +
            `zoom ${CAMERA_BOUNDS.zoom.minimum} to ${CAMERA_BOUNDS.zoom.maximum}, all finite and inclusive. ` +
            "Out-of-range submissions are refused. Accepted cameras render as stored, " +
            "except coverage moves a center nearer a pole than half the canvas height " +
            "toward the equator and raises zoom below log2(canvas height / 512), " +
            "accounting for view padding. Older stored cameras read clamped to these bounds without a write. " +
            "The viewport is one whole camera: omitted pitch and bearing store zero (flat and north-up).",
          properties: {
            lng: { type: "number" },
            lat: { type: "number", ...CAMERA_BOUNDS.lat },
            zoom: { type: "number", ...CAMERA_BOUNDS.zoom },
            pitch: { type: "number", ...CAMERA_BOUNDS.pitch },
            bearing: { type: "number", minimum: -360, maximum: 360 },
          },
        },
        MapTimeline: {
          type: ["object", "null"],
          description:
            "The map's docked playback timeline — at most one " +
            "per map. It names the layer whose time filter is expanded " +
            "into the map-docked widget with playback; the window itself " +
            "stays that layer's timerange filter. The layer must be " +
            "non-aggregated (points/heatmap draw real features; hex/grid " +
            "cells are aggregated server-side and cannot animate) and must " +
            "already carry a timerange filter on the field. Null means no " +
            "timeline is docked.",
          properties: {
            layerId: { type: "string", description: "A layer of this map." },
            field: {
              type: "string",
              description:
                "The temporal field — must match one of the layer's " +
                "timerange filters.",
            },
            speed: {
              type: "number",
              description:
                "Sweep-speed multiplier (0.25–32); 1 crosses the extent " +
                "at the base rate. Defaults to 1.",
            },
          },
          required: ["layerId", "field"],
        },
        MapWidget: {
          type: "object",
          description:
            "One dashboard card: a formula (headline " +
            "aggregate), category (top 5 + Other ranking; clicking a row " +
            "EXCLUDES it), histogram (distribution with a brushable " +
            "range), or note (authored title + body, no data). Data types " +
            "are computed server-side over their layer's effective query. " +
            "field is the aggregated/grouping/binned field (null for a " +
            "count formula and for notes); agg is count | sum | avg | min " +
            "| max (category ranking allows count | sum | avg; histogram " +
            "and note ignore it — send count); aggField is the field a " +
            "category sum/avg ranks by (null otherwise); unit/note/format " +
            "are formula presentation (note doubles as a note widget's " +
            "body); layerId is null exactly for notes.",
          properties: {
            id: { type: "string", description: "Unique within the map." },
            type: {
              type: "string",
              enum: ["formula", "category", "histogram", "note"],
            },
            layerId: {
              type: ["string", "null"],
              description:
                "The layer the widget reads — and the only layer its " +
                "selection filters. Null for notes.",
            },
            title: { type: "string", description: "Card heading (≤ 60)." },
            field: { type: ["string", "null"] },
            agg: {
              type: "string",
              enum: ["count", "sum", "avg", "min", "max"],
            },
            aggField: { type: ["string", "null"] },
            unit: {
              type: ["string", "null"],
              description: "Formula: text after the number (≤ 20).",
            },
            note: {
              type: ["string", "null"],
              description:
                "Formula: caption under the number; note widget: the body " +
                "(≤ 2000).",
            },
            format: {
              type: ["string", "null"],
              enum: [
                "compact",
                "percent",
                "percent2",
                "integer",
                "decimal1",
                "decimal2",
                null,
              ],
              description: "Formula number formatting; null = automatic.",
            },
            visible: { type: "boolean" },
          },
          required: [
            "id",
            "type",
            "layerId",
            "title",
            "field",
            "agg",
            "aggField",
            "unit",
            "note",
            "format",
            "visible",
          ],
        },
        WidgetList: {
          type: "array",
          items: { $ref: "#/components/schemas/MapWidget" },
          description: "The map's widgets, in rail order (at most 12).",
        },
        WidgetSelections: {
          type: "array",
          description:
            "Ephemeral cross-filter state: at most one " +
            "entry per widget — {widgetId, kind: 'exclude', values} names " +
            "a category widget's DEACTIVATED categories (all categories " +
            "are active by default; Other and unlisted categories stay); " +
            "{widgetId, kind: 'range', min, max} is a histogram brush " +
            "(null bounds are open-ended). The filtered field resolves " +
            "from the stored widget, never the request. Selections live " +
            "on the request and are never stored.",
          items: {
            type: "object",
            properties: {
              widgetId: { type: "string" },
              kind: { type: "string", enum: ["exclude", "range"] },
              values: { type: "array", items: { type: "string" } },
              min: { type: ["number", "null"] },
              max: { type: ["number", "null"] },
            },
            required: ["widgetId", "kind"],
          },
        },
        WidgetValues: {
          type: "object",
          description:
            "Batched widget values. Each entry answers for one visible " +
            "widget: formula {value, baseline} (baseline = the " +
            "selection-free value), category {categories: [{value, n}], " +
            "other} (top 5; other is the rollup or null), histogram " +
            "{domain, bins} (domain from the selection-free query so bars " +
            "shrink in place). A widget whose layer is gone or whose query " +
            "failed answers {id, error, errorCode} — the rest keep " +
            "working, and truth surfaces key their prose on errorCode " +
            "(widget_layer_missing, query_timeout, sql_error, …)" +
            " while error keeps the detail. layers carries per-layer " +
            "constrained/total row counts.",
          properties: {
            widgets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  type: {
                    type: "string",
                    enum: ["formula", "category", "histogram"],
                  },
                  value: { type: ["number", "null"] },
                  baseline: { type: ["number", "null"] },
                  categories: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        value: { type: "string" },
                        n: { type: "number" },
                      },
                    },
                  },
                  other: { type: ["number", "null"] },
                  domain: {
                    type: ["object", "null"],
                    properties: {
                      min: { type: "number" },
                      max: { type: "number" },
                    },
                  },
                  bins: { type: "array", items: { type: "integer" } },
                  error: { type: "string" },
                  errorCode: {
                    type: "string",
                    description:
                      "Machine-readable reason when error is present" +
                      "; one of the documented error codes.",
                  },
                },
                required: ["id"],
              },
            },
            layers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  layerId: { type: "string" },
                  count: { type: "integer" },
                  total: { type: "integer" },
                },
                required: ["layerId", "count", "total"],
              },
            },
          },
          required: ["widgets", "layers"],
        },
        Map: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            viewport: { $ref: "#/components/schemas/Viewport" },
            basemap: {
              type: ["string", "null"],
              description:
                "dark | light | streets | satellite; null is Auto — the " +
                "builder follows the app theme (a deployment basemap " +
                "override pins it), and published views render the " +
                "deployment default.",
            },
            customBasemap: {
              $ref: "#/components/schemas/CustomBasemap",
              description:
                "The map's custom basemap style; null = none. " +
                "When set it wins over the key in every surface; the key " +
                "survives underneath and returns when this clears.",
            },
            basemapLayers: { $ref: "#/components/schemas/BasemapLayers" },
            note: {
              $ref: "#/components/schemas/MapNote",
              description:
                "Legacy: always null — the map's old note field " +
                "migrated into a note widget. Kept for pre-migration " +
                "undo images.",
            },
            legendCorner: { $ref: "#/components/schemas/LegendCorner" },
            legendOrder: { $ref: "#/components/schemas/LegendOrder" },
            timeline: { $ref: "#/components/schemas/MapTimeline" },
            widgets: { $ref: "#/components/schemas/WidgetList" },
            widgetsPublished: {
              type: "boolean",
              description:
                "Whether widgets ship with the published view.",
            },
            publishToken: { type: ["string", "null"] },
            publishedAt: { type: ["string", "null"] },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
        },
        MapOverview: {
          allOf: [
            { $ref: "#/components/schemas/Map" },
            {
              type: "object",
              properties: {
                projectId: {
                  type: ["string", "null"],
                  description:
                    "The project this map is in; null = not in " +
                    "a project. Never part of the published view.",
                },
                layerCount: { type: "integer" },
                layerColors: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "One representative CSS color per layer, in draw " +
                    "order — what the maps screen renders as layer dots.",
                },
              },
            },
          ],
        },
        MapList: {
          type: "array",
          items: { $ref: "#/components/schemas/MapOverview" },
        },
        Project: {
          type: "object",
          description:
            "An optional named set over maps, workflows and datasets" +
            ", with its member counts and size composed in. " +
            "Workflows are workflow-origin recipes.",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            note: { type: ["string", "null"] },
            createdAt: { type: "string" },
            updatedAt: {
              type: "string",
              description:
                "When the set itself last changed: its name, note or " +
                "membership. A member's own edits do not advance it.",
            },
            mapCount: { type: "integer" },
            publishedMapCount: { type: "integer" },
            recipeCount: {
              type: "integer",
              description:
                "The project's workflow-origin recipes. The field name stays " +
                "`recipeCount` for wire compatibility.",
            },
            tableCount: { type: "integer" },
            sizeBytes: {
              type: "integer",
              description:
                "The sum of the member datasets' known artifact sizes.",
            },
            sizeComplete: {
              type: "boolean",
              description:
                "False when a member dataset's size is unknown — the sum " +
                "is partial and says so.",
            },
          },
          required: [
            "id",
            "name",
            "note",
            "createdAt",
            "updatedAt",
            "mapCount",
            "publishedMapCount",
            "recipeCount",
            "tableCount",
            "sizeBytes",
            "sizeComplete",
          ],
        },
        ProjectList: {
          type: "array",
          items: { $ref: "#/components/schemas/Project" },
        },
        ProjectMembers: {
          type: "object",
          description:
            "A project's members, each kind in its ordinary listing shape. " +
            "Project workflows are workflow-origin recipes.",
          properties: {
            maps: { $ref: "#/components/schemas/MapList" },
            recipes: {
              $ref: "#/components/schemas/RecipeList",
              description:
                "The project's workflow-origin recipes; the field name stays " +
                "`recipes` for wire compatibility.",
            },
            tables: { $ref: "#/components/schemas/TableList" },
          },
          required: ["maps", "recipes", "tables"],
        },
        ProjectMemberChange: {
          type: "object",
          description:
            "One atomic membership change: adds and removes together — " +
            "all applied or none. Ids name existing objects; one unknown " +
            "id changes nothing. Only workflows can be project " +
            "members.",
          properties: {
            addMaps: { type: "array", items: { type: "string" } },
            removeMaps: { type: "array", items: { type: "string" } },
            addRecipes: {
              type: "array",
              items: { type: "string" },
              description:
                "Recipe ids to add. Only workflows can be " +
                "project members.",
            },
            removeRecipes: { type: "array", items: { type: "string" } },
            addTables: { type: "array", items: { type: "string" } },
            removeTables: { type: "array", items: { type: "string" } },
          },
        },
        MapWithLayers: {
          allOf: [
            { $ref: "#/components/schemas/Map" },
            {
              type: "object",
              properties: {
                projectId: {
                  type: ["string", "null"],
                  description:
                    "The project this map is in; null = not " +
                    "in a project. Detail reads carry it; the published " +
                    "surfaces never do.",
                },
              },
            },
            {
              type: "object",
              properties: {
                layers: { $ref: "#/components/schemas/LayerList" },
              },
            },
          ],
        },
        MapUpdate: {
          type: "object",
          properties: {
            name: { type: "string" },
            viewport: { $ref: "#/components/schemas/Viewport" },
            basemap: {
              type: ["string", "null"],
              description:
                "dark | light | streets | satellite; null returns the map " +
                "to Auto (follows the app theme in the builder; published " +
                "views use the deployment default).",
            },
            customBasemap: {
              type: ["object", "null"],
              description:
                "Set or replace the map's custom basemap style" +
                "; null removes it and reveals the stored key again. " +
                "The server inspects the URL before saving: a valid style " +
                "saves with its attribution snapshot; unreachable or " +
                "policy-blocked URLs save only with force: true (every " +
                "reader's browser fetches the style itself, so they may " +
                "still work); non-style URLs never save.",
              properties: {
                url: { type: "string" },
                name: {
                  type: ["string", "null"],
                  description:
                    "Display name for the picker tile; absent shows the " +
                    "URL's hostname.",
                },
                force: {
                  type: "boolean",
                  description:
                    "Save despite an unreachable or blocked verdict.",
                },
              },
              required: ["url"],
            },
            basemapLayers: { $ref: "#/components/schemas/BasemapLayers" },
            legendCorner: { $ref: "#/components/schemas/LegendCorner" },
            legendOrder: { $ref: "#/components/schemas/LegendOrder" },
            timeline: { $ref: "#/components/schemas/MapTimeline" },
            widgets: { $ref: "#/components/schemas/WidgetList" },
            widgetsPublished: {
              type: "boolean",
              description:
                "Whether widgets ship with the published view.",
            },
            layerOrder: {
              type: "array",
              items: { type: "string" },
              description:
                "All the map's layer ids, bottom to top — the draw order.",
            },
          },
        },
        ...HISTORY_SCHEMAS,
        FillPaint: {
          type: "object",
          description:
            "A color paint, serving the fill and the data-driven outline: " +
            "{type: 'constant', color} · categorical {attribute, palette, " +
            "map: [{value, color}], other} · ramp {type: 'quantile', " +
            "attribute, palette, method: quantile|equal|natural|custom, " +
            "breaks, colors, optional classes} (breaks strictly ascending, one fewer than " +
            "colors) · continuous {type: 'continuous', attribute, palette, " +
            "domain: [low, high], stops, optional clamp: [low, high], log, " +
            "center, positions, reversed} (values interpolate " +
            "smoothly along the stops over the domain; clamp narrows the " +
            "effective domain, values outside take the end colors; log " +
            "needs a strictly positive effective domain; center splits the " +
            "ramp for diverging reads and starts at the mean when a " +
            "diverging palette is applied). Colors are {r, g, b, a}. " +
            "Computed breaks come back as nice rounded values. " +
            "To set custom class boundaries, write the ramp with method: " +
            "'custom', your breaks, and baseMethod naming the method they " +
            "derived from (quantile|equal|natural) — a later class-count " +
            "change recomputes from it. When a low-cardinality result can " +
            "realize fewer visible classes, classes remembers the " +
            "requested count.",
          properties: { type: { type: "string" } },
        },
        CustomPalette: {
          type: "object",
          description:
            "A saved custom palette: a named gradient of " +
            "ordered color stops, instance-global, usable wherever " +
            "palettes are offered (continuous and classified). Styles " +
            "reference it by name but bake resolved colors in, so deleting " +
            "a palette never breaks a map that used it.",
          properties: {
            name: {
              type: "string",
              description: "Stable id, assigned on save; use as `palette`.",
            },
            label: { type: "string", maxLength: 60 },
            stops: {
              type: "array",
              minItems: 2,
              maxItems: 16,
              items: {
                type: "object",
                properties: {
                  color: {
                    type: "string",
                    description: "#rrggbb",
                  },
                  position: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                    description: "0–1, non-decreasing across the stops.",
                  },
                },
                required: ["color", "position"],
              },
            },
          },
          required: ["name", "label", "stops"],
        },
        PaletteOffer: {
          type: "object",
          description:
            "Everything the palette picker offers: the curated catalogue " +
            "and the saved custom palettes.",
          properties: {
            curated: { type: "array", items: { type: "object" } },
            custom: {
              type: "array",
              items: { $ref: "#/components/schemas/CustomPalette" },
            },
          },
          required: ["curated", "custom"],
        },
        SizeScale: {
          type: "object",
          description:
            "Numeric attribute → pixel-size mapping. `domain` " +
            "is the attribute's value range (low, high) over the effective " +
            "result, resolved server-side; `range` is the output in pixels " +
            "(smallest, largest). Point radius maps area-honestly (square " +
            "root of the value); line width maps linearly. Features with a " +
            "missing or non-numeric value draw at the smallest size.",
          properties: {
            attribute: { type: "string" },
            domain: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
            },
            range: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
            },
          },
          required: ["attribute", "domain", "range"],
        },
        Aggregate: {
          type: "object",
          description:
            "What each cell shows: {fn: 'count'}, or {fn: 'sum' | 'avg' | " +
            "'min' | 'max', attribute} over a numeric attribute.",
          properties: {
            fn: {
              type: "string",
              enum: ["count", "sum", "avg", "min", "max"],
            },
            attribute: { type: "string" },
          },
          required: ["fn"],
        },
        Viz: {
          type: "object",
          description:
            "How the layer's result is drawn. `points` (default) draws the " +
            "raw features. `hexbin` and `grid` aggregate points into " +
            "cells server-side — results beyond the render cap stay " +
            "renderable; cells expose `value` and `count`, colored by the " +
            "viz `fill` (assigned automatically when omitted). `heatmap` " +
            "draws point density. `arc` and `line` draw each row as an " +
            "origin→destination pair from the mapped endpoints — arc as a " +
            "curved swing with an adjustable height, line straight; the " +
            "path's source color and width ride the style's stroke " +
            "channels, and `targetColor` blends toward the destination. " +
            "`icon` draws points as a glyph from the curated bundled set — " +
            "size rides the style's point-radius channel, color its fill " +
            "channel, fixed or by attribute. `cluster` aggregates points " +
            "client-side into count-labeled bubbles by a pixel radius; " +
            "zooming in dissolves them; clicking a bubble zooms toward " +
            "where it breaks apart. Non-point layers keep simple rendering. " +
            "hexbin/grid may carry `elevation`: cells extrude " +
            "by an aggregate — count, or a function over a numeric field — " +
            "so color and height can encode different things; the " +
            "aggregate's range is resolved server-side and maps linearly " +
            "onto [0, height] meters. Absent = flat, exactly as before.",
          properties: {
            type: {
              type: "string",
              enum: [
                "points",
                "hexbin",
                "grid",
                "heatmap",
                "arc",
                "line",
                "icon",
                "cluster",
              ],
            },
            cellKm: {
              type: "number",
              description:
                "hexbin/grid: cell edge length in **web-mercator** " +
                "kilometres — a length on the map projection, not a ground " +
                "distance. Web mercator stretches by 1/cos(latitude), so a " +
                "1.2 km cell covers about 730 m of ground at 52°N and about " +
                "410 m at 70°N. Any value 0.02-1000 (hexbin: hexagon edge; " +
                "grid: square edge). Every other distance in this API — a " +
                "buffer radius, a measured length — is ground metres.",
            },
            aggregate: { $ref: "#/components/schemas/Aggregate" },
            fill: { $ref: "#/components/schemas/FillPaint" },
            elevation: {
              type: "object",
              description:
                "hexbin/grid cell extrusion. height = the " +
                "tallest prism in meters (100-20000); domain is resolved " +
                "server-side — send aggregate and height only.",
              properties: {
                aggregate: { $ref: "#/components/schemas/Aggregate" },
                height: { type: "number", minimum: 100, maximum: 20000 },
                domain: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 2,
                  maxItems: 2,
                },
              },
              required: ["aggregate", "height"],
            },
            radiusPx: {
              type: "number",
              description:
                "heatmap: kernel radius in pixels (1-200). cluster: " +
                "clustering radius in pixels (20-120).",
            },
            intensity: {
              type: "number",
              description: "heatmap: intensity multiplier (0.1-10).",
            },
            weight: {
              type: ["string", "null"],
              description:
                "heatmap: numeric attribute weighting each point; null = 1.",
            },
            origin: { $ref: "#/components/schemas/OdEndpoint" },
            dest: { $ref: "#/components/schemas/OdEndpoint" },
            height: {
              type: "number",
              description:
                "arc: swing relative to the endpoint distance (0.1-2).",
            },
            targetColor: {
              type: "object",
              description:
                "arc/line: destination end of the color gradient as " +
                "{r, g, b, a}; omit for one fixed color.",
            },
            glyph: {
              type: "string",
              description:
                "icon: the glyph name from the curated Maki subset (e.g. " +
                "'cafe', 'parking', 'marker').",
            },
            customSvg: {
              type: ["string", "null"],
              description:
                "icon: sanitized custom SVG markup; when " +
                "present it wins over the glyph, tinted by the fill " +
                "channel like any glyph. Writes pass through the " +
                "sanitizer — scripts, event handlers and references are " +
                "stripped and reported (preview via /api/icons/sanitize); " +
                "not-SVG, oversize (256 KB), and nothing-drawable inputs " +
                "answer invalid_request. Null clears back to the glyph.",
            },
            color: {
              description:
                "cluster: 'fixed' paints the style's fill color; an " +
                "Aggregate ({fn} or {fn, attribute}) colors bubbles on a " +
                "sequential ramp over the current view's values.",
            },
            showCounts: {
              type: "boolean",
              description: "cluster: draw the count label on each bubble.",
            },
          },
          required: ["type"],
        },
        OdEndpoint: {
          type: ["object", "null"],
          description:
            "One arc/line endpoint: a geometry column of the " +
            "layer's result ({kind: 'geometry', field}) or a pair of " +
            "numeric longitude/latitude columns ({kind: 'lonlat', lon, " +
            "lat}). Null = not yet mapped; the layer asks instead of " +
            "rendering. The fields endpoint lists `geometryColumns`; " +
            "numeric columns come from `filterable`.",
          properties: {
            kind: { type: "string", enum: ["geometry", "lonlat"] },
            field: { type: "string" },
            lon: { type: "string" },
            lat: { type: "string" },
          },
          required: ["kind"],
        },
        LayerFilter: {
          type: "object",
          description:
            "A structured refinement of the layer's result, applied before " +
            "aggregation. Range: {field, kind: 'range', min, max} (numbers; " +
            "a null bound is open-ended). Time range: {field, kind: " +
            "'timerange', min, max} (ISO-8601 strings, e.g. '2021-03-01' or " +
            "'2021-03-01T08:30:00'; for date/timestamp fields). Value set: " +
            "{field, kind: 'values', values} (an empty set matches " +
            "nothing); with exclude: true the set inverts — keep everything " +
            "EXCEPT these values (NULL rows drop, as SQL's NOT IN decides).",
          properties: {
            field: { type: "string" },
            kind: { type: "string", enum: ["range", "timerange", "values"] },
            exclude: {
              type: "boolean",
              description: "values kind only: invert the set.",
            },
            min: {
              type: ["number", "string", "null"],
              description: "Number for range, ISO-8601 string for timerange.",
            },
            max: {
              type: ["number", "string", "null"],
              description: "Number for range, ISO-8601 string for timerange.",
            },
            values: { type: "array", items: { type: "string" } },
          },
          required: ["field", "kind"],
        },
        FieldStats: {
          type: "object",
          description:
            "A field's extent and distribution (numeric and time fields) or " +
            "distinct values (text; bounded, by frequency), for seeding " +
            "filter controls and the ramp's distribution. Time " +
            "extents are ISO-8601 strings. On an aggregated (hex/grid) " +
            "layer, `value` and `count` answer over the effective query — " +
            "the same values classification sees.",
          properties: {
            field: { type: "string" },
            kind: { type: "string", enum: ["numeric", "time", "text"] },
            numeric: { type: "boolean" },
            min: {
              type: ["number", "string", "null"],
              description: "Number for numeric, ISO-8601 string for time.",
            },
            max: {
              type: ["number", "string", "null"],
              description: "Number for numeric, ISO-8601 string for time.",
            },
            mean: {
              type: ["number", "null"],
              description: "Arithmetic mean; numeric fields only.",
            },
            bins: {
              type: "array",
              items: { type: "integer" },
              description:
                "Row counts over equal bins across [min, max] — the " +
                "distribution histogram behind a range brush. Empty when " +
                "the extent is missing or a single value.",
            },
            values: { type: "array", items: { type: "string" } },
            truncated: { type: "boolean" },
          },
          required: ["field", "kind", "numeric"],
        },
        Style: {
          type: "object",
          description:
            "A layer's full visual definition. Constant channels plus " +
            "data-driven ones: `strokeBy` drives the outline " +
            "color like `fill` drives the fill; `pointRadiusBy` and " +
            "`strokeWidthBy` drive the sizes. Absent data-driven members " +
            "mean the constant siblings apply.",
          properties: {
            fill: { $ref: "#/components/schemas/FillPaint" },
            fillOpacity: {
              type: "number",
              description:
                "0-1 fill translucency; 1 = opaque. Colors are solid — " +
                "the sliders own alpha. Default 1.",
            },
            stroke: {
              type: "object",
              description: "Constant outline color {r, g, b, a}.",
            },
            strokeOpacity: {
              type: "number",
              description: "0-1 multiplier on the stroke alpha. Default 1.",
            },
            strokeWidth: { type: "number" },
            pointRadius: { type: "number" },
            opacity: { type: "number" },
            strokeBy: {
              $ref: "#/components/schemas/FillPaint",
              description:
                "Data-driven outline color; overrides `stroke` when present.",
            },
            pointRadiusBy: {
              $ref: "#/components/schemas/SizeScale",
              description:
                "Data-driven point radius; overrides `pointRadius`.",
            },
            strokeWidthBy: {
              $ref: "#/components/schemas/SizeScale",
              description:
                "Data-driven line/outline width; overrides `strokeWidth`.",
            },
            heightBy: {
              $ref: "#/components/schemas/SizeScale",
              description:
                "Polygon extrusion by attribute: the domain " +
                "maps linearly onto meters (range up to 100000; resolve " +
                "with the scale operation, unit 'm'). Omit for flat.",
            },
            label: {
              type: "object",
              description:
                "Text labels on the layer; omit for none. On a " +
                "simple-feature layer set `attribute` to the column whose " +
                "value labels each feature (points at the point, lines and " +
                "polygons at an interior anchor). On an aggregated hex/grid " +
                "layer omit `attribute` — each cell labels itself with its " +
                "aggregate value, compactly formatted. Heatmaps cannot be " +
                "labeled.",
              properties: {
                attribute: {
                  type: "string",
                  description:
                    "Label source column; omit on aggregated layers.",
                },
                size: {
                  type: "number",
                  description:
                    "Text size, 1-72; 12 is a good default. On simple " +
                    "layers this is screen pixels. On hex/grid layers it " +
                    "scales the label's proportion of its cell — cell " +
                    "labels zoom with the map, like the cells themselves.",
                },
                color: {
                  type: "object",
                  description:
                    "Text color {r, g, b, a}. Pick against the basemap: " +
                    "white reads well on dark styles and imagery, a dark " +
                    "color on light styles.",
                },
                haloWidth: {
                  type: "number",
                  description:
                    "Halo rim behind the text, 0 (none) to 1 (full — the " +
                    "renderer saturates there). Replaced the legacy " +
                    "`halo` boolean: stored maps migrate on " +
                    "read; writes stating the boolean answer " +
                    "invalid_request.",
                },
                haloColor: {
                  type: "object",
                  description: "Halo color {r, g, b, a}.",
                },
                weight: {
                  type: "string",
                  enum: ["normal", "bold"],
                  description: "Absent = normal.",
                },
                anchor: {
                  type: "string",
                  description:
                    "One of the nine compass positions plus center, " +
                    "relative to the feature's anchor point; absent = " +
                    "center.",
                },
                offsetX: {
                  type: "number",
                  description: "Pixels, -50 to 50; +x right. Absent = 0.",
                },
                offsetY: {
                  type: "number",
                  description: "Pixels, -50 to 50; +y down. Absent = 0.",
                },
                rotation: {
                  type: "number",
                  description:
                    "Degrees, -180 to 180, counter-clockwise positive. " +
                    "Absent = 0.",
                },
                textCase: {
                  type: "string",
                  enum: ["as-is", "upper", "lower"],
                  description: "Applied before truncation. Absent = as-is.",
                },
                maxChars: {
                  type: ["number", "null"],
                  description:
                    "Truncate to N code points with an ellipsis (not " +
                    "counted), 1 to 80; null/absent = no truncation.",
                },
                density: {
                  type: "number",
                  description:
                    "Collision-culling density, 0 sparse to 1 " +
                    "dense; absent = 0.5. Table-backed layers only — tiled " +
                    "layers are exempt from thinning.",
                },
                zoomFloor: {
                  type: ["number", "null"],
                  description:
                    "Show labels from this whole zoom level (0-24); " +
                    "null/absent = no floor.",
                },
                priorityField: {
                  type: ["string", "null"],
                  description:
                    "Numeric column ranking which labels survive the cap " +
                    "and collisions (higher wins; nulls last); null/absent " +
                    "= stable feature order. Published maps carry the " +
                    "column's values.",
                },
                cap: {
                  type: ["number", "null"],
                  description:
                    "Draw at most N labels (1-10000), after ranking; " +
                    "null/absent = no cap.",
                },
              },
              required: ["size", "color", "haloWidth", "haloColor"],
            },
          },
        },
        Layer: {
          type: "object",
          properties: {
            id: { type: "string" },
            mapId: { type: "string" },
            name: { type: "string" },
            sql: { type: "string" },
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
            sql: { type: "string" },
            style: { $ref: "#/components/schemas/Style" },
          },
          required: ["sql"],
        },
        LayerUpdate: {
          type: "object",
          properties: {
            name: { type: "string" },
            sql: { type: "string" },
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
                "and cross-filter — publishes regardless of this list.",
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
        PublishedFieldsStatement: {
          type: "object",
          description:
            "Per-layer statement of the effective published field set" +
            ".",
          properties: {
            layers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  layerId: { type: "string" },
                  name: { type: "string" },
                  hidden: {
                    type: "boolean",
                    description:
                      "A hidden layer shares nothing — it is absent from " +
                      "the published surface entirely; its statement " +
                      "carries an empty field set.",
                  },
                  mode: {
                    type: "string",
                    enum: ["derived", "list"],
                    description:
                      "derived = the minimal projection; list = the " +
                      "author's explicit published-field list.",
                  },
                  fields: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        required: {
                          type: "boolean",
                          description:
                            "The published map cannot render without it; " +
                            "no list can remove it.",
                        },
                      },
                    },
                  },
                  available: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Every field an explicit list could name. Empty on " +
                      "aggregated layers, whose computed columns are the " +
                      "whole wire.",
                  },
                  list: {
                    type: ["array", "null"],
                    items: { type: "string" },
                    description:
                      "The author's raw explicit list, verbatim (null = " +
                      "derived). Editors write against this, never against " +
                      "the effective set.",
                  },
                  error: {
                    type: "string",
                    description:
                      "Present when this layer's fields cannot be " +
                      "resolved; the other layers still answer.",
                  },
                },
              },
            },
          },
        },
        LayerRender: {
          type: "object",
          properties: {
            layerId: { type: "string" },
            ok: { type: "boolean" },
            mode: {
              type: "string",
              enum: ["inline", "tiled"],
              description:
                "inline carries the GeoJSON itself; tiled points at served " +
                "vector tiles (a points-viz result over the render cap).",
            },
            geojson: {
              type: "object",
              description:
                "Inline GeoJSON. Non-point features carry a reserved " +
                "__anchor property — an interior [lng, lat] that labels " +
                "anchor on; it never shows in tooltips or " +
                "pop-ups.",
            },
            featureCount: { type: "integer" },
            geometryType: {
              type: ["string", "null"],
              enum: ["POINT", "LINESTRING", "POLYGON", "MIXED", null],
              description:
                "Canonical geometry family of the effective render result, " +
                "independent of inline or tiled delivery. Multi-geometry " +
                "variants collapse into their simple family; null means the " +
                "result is empty or its family is unknown.",
            },
            tiles: { $ref: "#/components/schemas/LayerTiles" },
            liveFiltered: {
              type: "boolean",
              description:
                "True when the data ships without the layer's live filters " +
                "(range/time filters on non-aggregated layers) — " +
                "the builder canvas enforces them client-side, so slider " +
                "and playback moves never refetch. Absent when every " +
                "filter is already applied in the SQL.",
            },
            error: {
              type: "object",
              description:
                "Present when ok is false: why the layer cannot render " +
                "right now. code is one of the documented error codes " +
                "(query_timeout, sql_error, render_cap_exceeded, " +
                "tiler_unavailable, tile_build_failed, …) and is what " +
                "truth surfaces present; message carries the " +
                "detail. Both builder and published viewer show an " +
                "errored layer as a visible failed state, never as " +
                "silent absence.",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
        SliderPreviewData: {
          type: "object",
          description:
            "Bounded point input for transient builder slider previews. " +
            "`exact` is false when `geojson` is a stable subset of the " +
            "source rows. This response is never durable layer state.",
          properties: {
            layerId: { type: "string" },
            exact: { type: "boolean" },
            sourceCount: { type: "integer" },
            sampledCount: { type: "integer" },
            budget: { type: "integer" },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  kind: {
                    type: "string",
                    enum: ["numeric", "time", "text"],
                  },
                },
                required: ["name", "kind"],
              },
            },
            geojson: { type: "object" },
          },
          required: [
            "layerId",
            "exact",
            "sourceCount",
            "sampledCount",
            "budget",
            "fields",
            "geojson",
          ],
        },
        LayerTiles: {
          type: "object",
          description:
            "How a tiled layer stands. While `building`, poll the render " +
            "endpoint. When `ready`, `url` is a {z}/{x}/{y} tile URL " +
            "template (with a cache-busting version parameter), and bounds " +
            "([west, south, east, north]) with the zoom range describe the " +
            "archive. A failed build reports as an errored layer instead.",
          properties: {
            state: { type: "string", enum: ["building", "ready"] },
            url: { type: "string" },
            bounds: {
              type: "array",
              items: { type: "number" },
              minItems: 4,
              maxItems: 4,
            },
            minZoom: { type: "integer" },
            maxZoom: { type: "integer" },
            builtAt: { type: "string" },
          },
          required: ["state"],
        },
        FieldList: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              numeric: { type: "boolean" },
              kind: {
                type: "string",
                enum: ["numeric", "time", "text"],
                description:
                  "The field's family: numeric, time (date/timestamp " +
                  "columns), or text. Decides the matching filter kind.",
              },
            },
          },
        },
        LayerFields: {
          type: "object",
          properties: {
            styling: { $ref: "#/components/schemas/FieldList" },
            filterable: { $ref: "#/components/schemas/FieldList" },
            geometryColumns: {
              type: "array",
              items: { type: "string" },
              description:
                "Geometry columns of the layer's own SQL result, in SELECT " +
                "order — what arc/line endpoints can map to.",
            },
          },
        },
        LayerExtent: {
          type: "object",
          description:
            "A layer's current data extent. `empty` is a " +
            "distinct outcome from a failure: filtering everything away is " +
            "a normal thing to do.",
          properties: {
            kind: { type: "string", enum: ["extent", "empty"] },
            box: {
              type: "array",
              items: { type: "number" },
              description: "[west, south, east, north]; absent when empty.",
            },
          },
        },
        PublishState: {
          type: "object",
          properties: {
            token: { type: "string" },
            publishedAt: { type: "string" },
          },
        },
        ViewerControls: {
          type: "object",
          description:
            "Which optional reader controls a publication exposes" +
            ". Zoom and point-north are never listed: a published map " +
            "a reader cannot navigate reads as broken, so they are not the " +
            "author's to remove. Every member defaults to true.",
          properties: {
            tilt: { type: "boolean", description: "The 3D tilt toggle." },
            fit: { type: "boolean", description: "The fit-to-data button." },
            theme: {
              type: "boolean",
              description: "The reader's light/dark toggle.",
            },
            basemap: {
              type: "boolean",
              description: "The basemap picker.",
            },
            coords: {
              type: "boolean",
              description:
                "The cursor coordinate readout in the attribution strip" +
                ".",
            },
          },
        },
        PublicationState: {
          type: "object",
          description:
            "An active publication's authored settings.",
          properties: {
            token: { type: "string" },
            publishedAt: { type: "string" },
            theme: { type: "string", enum: ["light", "dark"] },
            viewerControls: { $ref: "#/components/schemas/ViewerControls" },
          },
        },
        PublishedView: {
          type: "object",
          properties: {
            name: { type: "string" },
            viewport: { $ref: "#/components/schemas/Viewport" },
            theme: {
              type: "string",
              enum: ["light", "dark"],
              description:
                "The authored default theme: the mode the " +
                "publisher stated or was composing in when the map was " +
                "published. Publications made before this field existed " +
                "read dark until published anew. A reader may switch " +
                "locally for the current page load only (the remembered " +
                "per-link override was retired); the switch never changes " +
                "this value, " +
                "and the next load starts from it again.",
            },
            basemapUrl: {
              type: "string",
              description:
                "Resolved basemap style URL for the authored theme — the " +
                "published page's first render uses exactly this.",
            },
            basemapForTheme: {
              type: ["object", "null"],
              description:
                "Non-null when the basemap follows the effective theme " +
                "(a genuine Auto with no deployment override): the style " +
                "URL for each mode (`light`, `dark`), so a reader theme " +
                "switch swaps styles without another round trip. Null for " +
                "an explicit basemap or an overridden Auto. In the builder " +
                "every explicit basemap stays fixed in both themes; on " +
                "the published viewer the Dark and Light styles are " +
                "excepted, and the reader's theme control moves them " +
                "as a pair — they are the two modes. Streets and Satellite " +
                "stay fixed there too.",
            },
            basemapKey: {
              type: ["string", "null"],
              enum: ["dark", "light", "streets", "satellite", null],
              description:
                "The authored basemap choice; null = Auto. The " +
                "reader's picker marks its card from this and resolves a " +
                "return to Auto — the resolved URL alone cannot say " +
                "whether Auto or an explicit style sharing that URL was " +
                "authored. Note the published Dark/Light exception " +
                "described on `basemapForTheme`: a reader's theme control " +
                "moves those two as a pair.",
            },
            customBasemap: {
              $ref: "#/components/schemas/CustomBasemap",
              description:
                "The map's custom basemap style; null = none. " +
                "When set, basemapUrl is its URL in both themes, the " +
                "attribution is its saved snapshot, and the reader's " +
                "picker marks no built-in card — a reader who switches to " +
                "one has no way back within the load.",
            },
            basemapPinned: {
              type: "boolean",
              description:
                "Whether this deployment pins Auto in both themes" +
                ". A reader's theme switch leaves a pinned Auto alone; " +
                "an explicit reader pick still applies for that page load.",
            },
            basemapKind: {
              type: "string",
              enum: ["vector", "imagery"],
              description:
                "The resolved style's kind — group toggles act " +
                "on vector styles only.",
            },
            basemapAttribution: {
              $ref: "#/components/schemas/BasemapAttribution",
            },
            basemapLayers: { $ref: "#/components/schemas/BasemapLayers" },
            note: { $ref: "#/components/schemas/MapNote" },
            legendCorner: { $ref: "#/components/schemas/LegendCorner" },
            legendOrder: { $ref: "#/components/schemas/LegendOrder" },
            timeline: {
              type: ["object", "null"],
              description:
                "The docked playback timeline, resolved for the viewer: " +
                "layerId, field, speed, the settled window, " +
                "the field's full extent (ISO-8601), and its histogram " +
                "bins. Null when no timeline is docked or the dock no " +
                "longer resolves.",
            },
            layers: {
              type: "array",
              items: { type: "object" },
              description:
                "Each layer carries its style, render data, and " +
                "`liveFilters`: resolved range/time filters the " +
                "render shipped without — the viewer enforces their " +
                "settled ranges client-side.",
            },
            widgets: {
              $ref: "#/components/schemas/WidgetList",
              description:
                "The map's visible widgets, present when the " +
                "map ships widgets — the viewer reads values through the " +
                "published widget-values call. Empty when the toggle is " +
                "off or no widget resolves.",
            },
            viewerControls: {
              $ref: "#/components/schemas/ViewerControls",
              description:
                "Which optional reader controls this publication exposes" +
                ". A publication that never stated a set " +
                "reports every control on.",
            },
          },
        },
        ...TABLE_CATALOGUE_SCHEMAS,
        ...ASSISTANT_SCHEMAS,
      },
    },
    "x-error-codes": ERROR_CATALOGUE,
  };
}
