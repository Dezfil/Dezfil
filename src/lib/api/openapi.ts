import { EXTERNAL_SIGN_IN_PATHS, EXTERNAL_SIGN_IN_SCHEMAS } from "./openapi-external-sign-in";
import { SMALL_JSON_BODY_MAX_BYTES } from "./request-bounds";
import { withAutomaticMethods } from "./openapi-methods";
import { DOCUMENT_FACT_PROPERTIES, DOCUMENT_FACT_SCHEMA, EDIT_REVISION_SCHEMA } from "./openapi-document-facts";
import { SQL_POLICY, SQL_QUERY } from "./openapi-sql";
import { PUBLICATION_ADMIN_PATHS, publicationAccess } from "./openapi-publications";
import { PUBLISHED_SATELLITE_PATHS, SATELLITE_TILE_DESCRIPTION, SATELLITE_TILE_PARAMETERS, SATELLITE_TILE_RESPONSES, SATELLITE_TILE_SIGNED_IN } from "./openapi-satellite";
import { resultAccess } from "./openapi-result-access";
import { JOB_PATHS } from "./openapi-jobs";
import { withRequestPolicy } from "./openapi-request-policy";
import { withExamples } from "./openapi-examples";
import { USERS_PATHS, USERS_SCHEMAS } from "./openapi-users";
import { ACCOUNT_PATHS, ACCOUNT_SCHEMAS } from "./openapi-account";
import { AUTH_PATHS, AUTH_SCHEMAS, AUTH_SECURITY_SCHEMES } from "./openapi-auth";
import { PROFILE_PICTURE_PATHS, PROFILE_PICTURE_SCHEMAS } from "./openapi-profile-pictures";
import { settingsContract } from "./openapi-settings";
import { INSTANCE_DEFAULTS_SCHEMA, INSTANCE_SETTINGS_PATHS, INSTANCE_SETTINGS_SCHEMAS, instanceRulesSchema } from "./openapi-instance-settings";
import { INSTANCE_SERVICES_PATHS, INSTANCE_SERVICES_SCHEMAS } from "./openapi-instance-services";
import { INSTANCE_SYSTEM_PATHS, INSTANCE_SYSTEM_SCHEMAS } from "./openapi-instance-system";
import { INSTANCE_BASEMAPS_PATHS, INSTANCE_BASEMAPS_SCHEMAS, LIBRARY_STYLE_OFFER_SCHEMA } from "./openapi-instance-basemaps";
import { TEMPLATES_PATHS, TEMPLATES_SCHEMAS } from "./openapi-templates";
import { RULE_KEYS, WHO_MAY_RULES } from "@/lib/settings/instance-rules";
import { OFFERED_SETTING, SINGLE_MAP_STYLES_SETTING } from "@/lib/basemap";
import { QUERY_EXPORT_TICKET } from "./openapi-tool-responses";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, LOCAL_TRANSIENT_READ, REMOTE_READ } from "./operation-mcp";
import { HISTORY_PATHS, HISTORY_SCHEMAS, MCP_PATHS } from "./openapi-mcp";
import { TABLE_CATALOGUE_PATHS, TABLE_CATALOGUE_SCHEMAS } from "./openapi-table-catalogue";
import { ASSISTANT_PATHS } from "./openapi-assistant";
import { ASSISTANT_SCHEMAS } from "./openapi-assistant-schemas";
import { MAP_LOOK_SCHEMAS } from "./openapi-map-look";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { ERROR_RESPONSE, op, jsonOk, pathParam } from "./openapi-helpers";
import { GEOMETRY_RESOURCE_PATHS } from "./openapi-geometry-resource";
import { GEOMETRY_RESOURCE_SCHEMAS } from "./openapi-geometry-schemas";
import { GEOMETRY_EVIDENCE_SCHEMAS } from "./openapi-geometry";
import { CAMERA_BOUNDS } from "@/lib/map-runtime-limits";
import { ERROR_CATALOGUE, RESOURCE_ERROR_STATUSES } from "./error-catalogue";
import { ENGINE_UNREADY } from "@/lib/system/readiness-reasons";
import { TOKEN_LENGTH } from "@/lib/publish/token";
import { EXPORT_IMAGE_DEFINITION_SCHEMA } from "@/lib/export/image-definition";
import { TABLE_COLLECTION_PATHS, TABLE_RESOURCE_PATHS, TABLE_SCHEMAS, TABLE_INSPECTION_SCHEMAS } from "./openapi-tables";
import { IMPORT_PATHS, IMPORT_SCHEMAS } from "./openapi-imports";
import { CONNECTION_PATHS, CONNECTION_SCHEMAS } from "./openapi-connections";
import { RECIPE_PATHS } from "./openapi-recipes";
import { MAP_COLLECTION_PATHS, MAP_RESOURCE_PATHS, MAP_RENDER_PATHS, MAP_PUBLISH_PATHS, MAP_DEPENDENCY_SCHEMAS, MAP_SCHEMAS, MAP_DETAIL_SCHEMAS } from "./openapi-maps";
import { PROJECT_PATHS, PROJECT_DEPENDENCY_SCHEMAS, PROJECT_SCHEMAS } from "./openapi-projects";
import { SHARING_PATHS, SHARING_SCHEMAS } from "./openapi-sharing";
import { WRITTEN_IN_REF, WRITTEN_IN_SCHEMAS } from "./openapi-written-in";
import { SKETCH_PATHS } from "./openapi-sketches";
import { LAYER_RESOURCE_PATHS, LAYER_QUERY_PATHS, LAYER_SCHEMAS } from "./openapi-layers";
import { RECIPE_DEPENDENCY_SCHEMAS, RECIPE_SCHEMAS } from "./openapi-recipe-schemas";

/**
 * The OpenAPI description of Dezfil's API — the single source of truth for
 * the human docs and the parity check (spec: a machine-readable description
 * ships alongside the human docs and never diverges). Every capability the UI
 * uses is here; the parity test fails if any route or UI call is missing.
 *
 * Hand-authored resource contracts are assembled here and wrapped as MCP tools
 * directly.
 */

export function buildOpenApiDocument() {
  const settings = settingsContract();
  return withExamples(withRequestPolicy(withAutomaticMethods({
    openapi: "3.1.0",
    info: {
      title: "Dezfil API",
      version: "0.1.0",
      description:
        "Upload files, query them with SQL, compose styled map layers, and " +
        "publish read-only shareable views. Every capability the UI offers is " +
        "one of these documented calls; the whole journey can be driven headlessly. " +
        "Protected operations require a current cookie session or account bearer token. " +
        "Every map, dataset, workflow, connection and project has one owner and is private to its owner unless a project shares it: " +
        "a project's owner gives people the viewer or editor role, and they reach the project and everything filed in it, whoever owns it. " +
        "A viewer reads; an editor also changes the content of its maps and workflows and runs its workflows; deletion, publication, sharing and transfer stay the owner's, " +
        "and datasets change only by their owner. Connections are never shared, and standalone jobs, renders and downloads stay with the account that started them. " +
        "Administrators have no additional content access. Dataset and connection names are owner-local: in SQL another person's reachable dataset is <sql name>.<dataset>, " +
        "and a map's or workflow's SQL reads in its SQL home. Unreached and missing resources share the same refusal. Instance catalogues and saved palettes remain shared. " +
        "User SQL reads named datasets only; direct or indirect file reads and path discovery are refused. " +
        "Cookie mutations require the same trusted Origin. Identity-bearing responses, " +
        "including authentication refusals, are private, no-store. Only entry, readiness " +
        "and the token-scoped read-only published projection permit anonymous access. " +
        "Maps and workflows have one durable editRevision, paired with state on document, child and list reads. " +
        "Covered writes require X-Edit-Revision (MCP expected_revision); order writes and chain the accepted JSON result. " +
        "Missing or malformed revisions return 400 invalid_request. Stale revisions return 409 stale_revision: This item has changed. Reload it before trying again. " +
        "Refusal changes nothing. Reload explicitly and compose a new edit, never replay an old payload under a fresh token. " +
        "This breaks unversioned writers and clients expecting bodyless covered successes. Whole-document deletion has no surviving revision. " +
        "Viewport-only saves, picture refresh and run cancellation keep their documented exceptions. " +
        "Attribution names the last accepted actor, not the owner; legacy authors can be unknown. Shared map undo retains original authors. " +
        "Run starts use the plan revision; admitted runs track executable definitions, preserving concurrent layout and lifecycle changes. " +
        "Unsupported methods on documented paths return 405 method_not_allowed with an exact Allow header after authentication. HEAD is bodyless and OPTIONS reports Allow.",
    },
    tags: [
      { name: "Accounts", description: "Local accounts and authentication." },
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
          "A project is also the one boundary of sharing: its owner " +
          "gives people the viewer or editor role, and they reach " +
          "everything filed in it, whoever owns it. Filing never changes " +
          "who owns a resource or what a plain table name means in a " +
          "map's or workflow's SQL. Deleting one dissolves the set, ends " +
          "every person's reach through it and deletes nothing.",
      },
      {
        name: "Templates",
        description:
          "Finished maps and workflow examples with their data, shipped " +
          "in the image or listed by the template catalogue, for every " +
          "signed-in account. A template belongs to no one and is listed " +
          "among no one's maps, workflows or datasets.",
      },
      {
        name: "Agents",
        description:
          "Drive Dezfil from AI agents: the documented API surface, " +
          "served as MCP tools, plus the in-product assistant.",
      },
    ],
    paths: {
      ...AUTH_PATHS,
      ...EXTERNAL_SIGN_IN_PATHS,
      ...ACCOUNT_PATHS,
      ...USERS_PATHS,
      ...INSTANCE_SETTINGS_PATHS,
      ...INSTANCE_SERVICES_PATHS,
      ...INSTANCE_SYSTEM_PATHS,
      ...INSTANCE_BASEMAPS_PATHS,
      ...TEMPLATES_PATHS,
      ...GEOMETRY_RESOURCE_PATHS,
      "/api/health": {
        get: op({
          summary: "Readiness check",
          description: "Readiness reports whether socket provenance is installed, the data directory is usable, and, once a query has started the query engine that runs SQL, whether that engine can serve. Readiness starts no engine before a query does. A started engine is asked a trivial statement on its own connection, not behind any account's queries: a statement that fails reads unready, and one with no answer within 2 seconds reads ready, since a busy engine is not a dead one. An engine whose last start failed reads unready, and readiness starts it again at most once every 30 seconds, so an instance taken out of rotation recovers once the cause clears. Unready, the reason names storage or the query engine, never a path or the engine's own words.",
          tag: "System",
          tool: "check_health", mcp: LOCAL_READ,
          display: {"verb": "Checked the instance"},
          effects: READ_ONLY,
          responses: {
            "200": jsonOk("#/components/schemas/Health", "Ready."),
            "503": jsonOk("#/components/schemas/HealthUnready", "The ingress preload, storage or the query engine is unavailable."),
          },
        }),
      },
      "/api/config": {
        get: op({
          summary: "Runtime client configuration",
          description: "Instance-wide basemaps, built-in palettes, client limits, the defaults new maps, layers and screens start with, whether the template catalogue is in use, the rules every account follows and the shortest password, shared by every authenticated account. Includes deployment-configured basemap choices and provider availability, never server-side AI or geocoder credentials. Private, no-store.",
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
            "A MapLibre style document for the imagery this instance " +
            "configures, with the provider's credit. Its raster source names " +
            "this instance's own tile address, " +
            "`/api/basemaps/satellite/tiles/{z}/{x}/{y}{ratio}`, never the " +
            "configured tile template: the server fetches each tile from the " +
            "template, so the template and a key in it never leave the server. " +
            "It answers signed-in accounts only; an anonymous request is " +
            "refused. No imagery ships with the app, so an instance that " +
            "configures none answers 404 and offers no imagery basemap, as " +
            "does one whose tile template carries a user name or password. A " +
            "stored template the instance's key no longer opens is refused " +
            "with service_address_unreadable, never answered with another " +
            "style. A published page's reader has the publication's own " +
            "style address. Private, no-store.",
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
            "400": ERROR_RESPONSE,
            "401": ERROR_RESPONSE,
            "404": { description: "No imagery is configured." },
          },
        }),
      },
      "/api/basemaps/satellite/tiles/{z}/{x}/{y}": {
        get: op({
          summary: "One tile of the configured imagery",
          description: `${SATELLITE_TILE_DESCRIPTION} ${SATELLITE_TILE_SIGNED_IN} ` +
            "Signed-in accounts only; an anonymous request is refused and " +
            "asks the imagery nothing. A published page's reader has the " +
            "publication's own tile address.",
          tag: "System",
          tool: false,
          effects: READ_ONLY,
          parameters: SATELLITE_TILE_PARAMETERS,
          responses: SATELLITE_TILE_RESPONSES,
        }),
      },
      "/api/palettes": {
        get: op({
          summary: "List palettes",
          description:
            "Shared by every authenticated account. The full palette offer: the curated catalogue " +
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
            "Every authenticated account may save a named gradient of ordered color stops. " +
            "Instance-global: it appears in every map's picker and works " +
            "in continuous and classified fills alike. Returns the saved " +
            "palette with its assigned name.",
          tag: "System",
          tool: "create_palette", mcp: LOCAL_ADD,
          display: {"verb": "Saved the palette {subject}", "subject": {"resource": "palettes", "result": "name", "name": ["name"]}},
          effects: writes(resource("palettes", "", "name")),
          requestBody: {
            "x-byte-limit": 16_777_216,
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
            "Every authenticated account may remove any saved custom palette from the shared picker. " +
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
      ...settings.paths,
      "/api/openapi.json": {
        get: op({
          summary: "This OpenAPI description",
          description: "The same API reference for every authenticated account. Contains operation contracts, never private resource listings or credential values. Private, no-store.",
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
      ...TABLE_COLLECTION_PATHS,
      ...IMPORT_PATHS,
      ...CONNECTION_PATHS,
      ...TABLE_RESOURCE_PATHS,
      "/api/operations": {
        get: op({
          summary: "List the operations this instance offers",
          description:
            "The instance-wide operation catalog, shared by every authenticated account: each verb's id, group, the " +
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
      ...JOB_PATHS,
      ...RECIPE_PATHS,
      "/api/query": {
        post: op({
          summary: "Run read-only SQL",
          description:
            SQL_POLICY + " " +
            "Named datasets resolve only " +
            "within the caller's reach: a plain name, and its catalog-qualified " +
            "forms, is the caller's own dataset; another person's dataset the " +
            "caller reaches through a project is <sql name>.<dataset>, and the " +
            "caller's own SQL name qualifies their own. Both hold in " +
            "query()/query_table() expressions and nested SQL. Each evaluation uses fresh " +
            "connection-local views on one shared hardened engine. Returns a capped " +
            "preview plus the exact total row count. Geometry cells in the " +
            "preview are WKT text by default; pass geometry: \"geojson\" " +
            "to receive GeoJSON geometry objects instead. The complete UTF-8 JSON answer " +
            "is limited to 33,554,432 bytes (32 MiB), and each non-geometry " +
            "cell to 2,097,152 bytes (2 MiB), including JSON escaping. Equality " +
            "is admitted. Native GEOMETRY columns, including CRS-qualified types, " +
            "count toward the result limit only. Geometry-looking text and explicit " +
            "WKT/GeoJSON text remain non-geometry. An oversized answer is refused " +
            "in full with HTTP 422 query_result_too_large, without partial rows. " +
            "These fixed limits do not change row limits, engine budgets or exports. A " +
            "failing statement answers with the engine's message and, when " +
            "the location maps to the submitted text, a 1-based line and column into the " +
            "submitted SQL.",
          tag: "Query",
          tool: "run_sql", mcp: LOCAL_READ,
          display: {"verb": "Ran a query"},
          effects: READ_ONLY,
          requestBody: {
            "x-byte-limit": 16_777_216,
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sql: SQL_QUERY,
                    geometry: {
                      type: "string",
                      enum: ["wkt", "geojson"],
                      description:
                        "How geometry columns travel in the preview. " +
                        "Default wkt.",
                    },
                    writtenIn: {
                      ...WRITTEN_IN_REF,
                      description:
                        "Evaluate the SQL where it was written: in a map's " +
                        "SQL home, as its layers are, or in a workflow's " +
                        "context with its declared outputs as the caller " +
                        "runs them, always within the caller's reach. A " +
                        "name that binds nothing there, when the home is " +
                        "someone else's, is refused naming it, as a layer's " +
                        "would be. Omitted or console, the caller's own " +
                        "console.",
                    },
                  },
                  required: ["sql"],
                },
                example: { sql: "SELECT * FROM my_table LIMIT 100" },
              },
            },
          },
          responses: { "200": jsonOk("#/components/schemas/QueryResult"), "400": ERROR_RESPONSE, "422": ERROR_RESPONSE },
        }),
      },
      "/api/query/export": {
        post: op(resultAccess({
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
            "x-byte-limit": 16_777_216,
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sql: SQL_QUERY,
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
        })),
        get: op(resultAccess({
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
        })),
      },
      ...MAP_COLLECTION_PATHS,
      ...PROJECT_PATHS,
      ...SHARING_PATHS,
      ...PROFILE_PICTURE_PATHS,
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
            "x-byte-limit": 16_777_216,
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
            "x-byte-limit": 16_777_216,
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
      ...MAP_RESOURCE_PATHS,
      ...HISTORY_PATHS,
      ...SKETCH_PATHS,
      ...LAYER_RESOURCE_PATHS,
      ...MAP_RENDER_PATHS,
      ...LAYER_QUERY_PATHS,
      ...MAP_PUBLISH_PATHS,
      ...PUBLICATION_ADMIN_PATHS,
      ...TABLE_CATALOGUE_PATHS,
      ...ASSISTANT_PATHS,
      ...MCP_PATHS,
      "/api/published/{token}": {
        get: op(publicationAccess({
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
        })),
      },
      "/api/published/{token}/extent/{layerId}": {
        post: op(publicationAccess({
          summary: "A published layer's current data extent",
          description:
            `At most ${SMALL_JSON_BODY_MAX_BYTES.toLocaleString("en-US")} wire bytes. Excess answers 413 ` +
            "`request_body_too_large` before JSON parsing. Empty bodies keep their default selections. " +
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
            "x-byte-limit": 65_536,
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
        })),
      },
      "/api/published/{token}/widget-values": {
        post: op(publicationAccess({
          summary: "Widget values for a published view",
          description:
            `At most ${SMALL_JSON_BODY_MAX_BYTES.toLocaleString("en-US")} wire bytes. Excess answers 413 ` +
            "`request_body_too_large` before JSON parsing. Empty bodies keep their default selections. " +
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
            "x-byte-limit": 65_536,
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
        })),
      },
      "/api/published/{token}/render/{layerId}": {
        post: op(publicationAccess({
          summary: "Re-render a published computed layer under selections",
          description:
            `At most ${SMALL_JSON_BODY_MAX_BYTES.toLocaleString("en-US")} wire bytes. Excess answers 413 ` +
            "`request_body_too_large` before JSON parsing. Empty bodies keep their default selections. " +
            "The published settle lane: re-render one hexbin, " +
            "grid, cluster, or heatmap layer under a reader's ephemeral " +
            "selections — cells re-bin and clusters recount, read-only, " +
            "with the same token checks and rate limit as other published " +
            "reads. Selections may only reference fields the published " +
            "surface declares — the layer's effective published field set, " +
            "or a published widget's field; anything else " +
            "answers 400 field_not_published before evaluation. Responses " +
            "carry the effective set, and a hidden layer answers 404 like " +
            "an absent one. Selection documents above 65,536 bytes are refused even when their filters meet the semantic count limits.",
          tag: "Publish",
          tool: false,
          effects: READ_ONLY,
          parameters: [
            pathParam("token", `Publish token (${TOKEN_LENGTH} characters).`),
            pathParam("layerId", "Layer id within the published map."),
          ],
          requestBody: {
            "x-byte-limit": 65_536,
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
        })),
      },
      "/api/published/{token}/tiles/{layerId}/{z}/{x}/{y}": {
        get: op(publicationAccess({
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
        })),
      },
      ...PUBLISHED_SATELLITE_PATHS,
    },
    components: {
      securitySchemes: AUTH_SECURITY_SCHEMES,
      schemas: {
        ...AUTH_SCHEMAS,
        ...EXTERNAL_SIGN_IN_SCHEMAS,
        ...PROFILE_PICTURE_SCHEMAS,
        ...WRITTEN_IN_SCHEMAS,
        ...ACCOUNT_SCHEMAS,
        ...USERS_SCHEMAS,
        ...INSTANCE_SETTINGS_SCHEMAS,
        ...INSTANCE_SERVICES_SCHEMAS,
        ...INSTANCE_SYSTEM_SCHEMAS,
        ...INSTANCE_BASEMAPS_SCHEMAS,
        ...TEMPLATES_SCHEMAS,
        // Documented as a schema only: the operation that consumes it is
        // the server renderer's feature, and a tool name before that
        // operation exists would hand agents an inert schema and call it
        // capability.
        ExportImageDefinition: EXPORT_IMAGE_DEFINITION_SCHEMA,
        ...MAP_LOOK_SCHEMAS,
        ...IMPORT_SCHEMAS,
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", enum: Object.keys(ERROR_CATALOGUE) },
                message: { type: "string" },
                account: { $ref: "#/components/schemas/Account", description: "The current browser account on an already_signed_in arrival refusal." },
                retryAfter: { type: "integer", minimum: 1, description: "Seconds before retry after a login limit or temporary authentication capacity refusal." },
                retryAt: { type: "string", format: "date-time", description: "When a login limit permits another attempt." },
                rule: { type: "string", enum: [...WHO_MAY_RULES], description: "The instance rule that refused a rule_refused request, keyed as PATCH /api/instance/settings takes it." },
                setting: { type: "string", enum: [...Object.values(OFFERED_SETTING), SINGLE_MAP_STYLES_SETTING], description: "The switch that refused a basemap_not_offered request: the one hiding the basemap it chose, or basemaps.singleMapStyles for a style address the basemap library does not offer, keyed as PATCH /api/instance/settings takes it." },
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
            reason: { type: "string", enum: [ERROR_CATALOGUE.internal, ENGINE_UNREADY] },
          },
        },
        ...PROJECT_DEPENDENCY_SCHEMAS,
        ...MAP_DEPENDENCY_SCHEMAS,
        ...RECIPE_DEPENDENCY_SCHEMAS,
        ...settings.schemas,
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
            basemapStyles: {
              type: "array",
              description:
                "The styles an admin added to the basemap library and offers, " +
                "oldest first, chosen by their id; hidden ones are left out.",
              items: LIBRARY_STYLE_OFFER_SCHEMA,
            },
            singleMapStyles: {
              type: "boolean",
              description:
                "Whether a map may take a style address the basemap library " +
                "does not offer (the basemaps.singleMapStyles setting). Off, " +
                "such an address is refused with basemap_not_offered when a " +
                "map write or an undo or redo would newly put it on a map; a " +
                "map that holds one keeps it.",
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
            defaults: INSTANCE_DEFAULTS_SCHEMA,
            templates: {
              type: "object",
              required: ["catalogue"],
              additionalProperties: false,
              properties: {
                catalogue: {
                  type: "boolean",
                  description:
                    "Whether the template catalogue is in use (the " +
                    "templates.catalogue setting). Off, the server reads " +
                    "it for nothing; shipped and downloaded templates " +
                    "still open and copy.",
                },
              },
            },
            rules: instanceRulesSchema(RULE_KEYS),
            externalSignIn: { type: "object", additionalProperties: false, required: ["enabled"], properties: { enabled: { type: "boolean" } } },
            passwordMin: {
              type: "integer", minimum: 8, maximum: 64,
              description:
                "The instance's shortest password: the fewest characters a " +
                "password set from now may have, from 8 to 64. Admins change " +
                "it; passwords set earlier keep signing in.",
            },
          },
        },
        SearchResults: {
          type: "object",
          description:
            "The grouped map-search answer. `places` is " +
            "present only when asked for, `refusedLayers` only when a " +
            "layer's values were refused.",
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
            refusedLayers: {
              type: "array",
              description:
                "Visible layers whose matching values were refused: one of " +
                "them is longer than 2,097,152 bytes (2 MiB) as a JSON " +
                "string, the ceiling for one value. Such a layer answers no " +
                "value rows; the others answer as usual. Each entry carries " +
                "the error and errorCode a failed widget carries " +
                "(query_result_too_large). Other layer failures contribute " +
                "nothing and are not listed.",
              items: {
                type: "object",
                required: ["layerId", "layerName", "error", "errorCode"],
                properties: {
                  layerId: { type: "string" },
                  layerName: { type: "string" },
                  error: { type: "string" },
                  errorCode: {
                    type: "string",
                    description: "One of the documented error codes.",
                  },
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
                "A distance is measured in a transverse Mercator centred on " +
                "the data's own extent, recorded as its PROJ definition; an " +
                "area in a global equal-area projection, recorded as its " +
                "EPSG code.",
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
        ...RECIPE_SCHEMAS,
        ...GEOMETRY_EVIDENCE_SCHEMAS,
        ...GEOMETRY_RESOURCE_SCHEMAS,
        ...TABLE_SCHEMAS,
        ...CONNECTION_SCHEMAS,
        ...TABLE_INSPECTION_SCHEMAS,
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
        ...MAP_SCHEMAS,
        ...PROJECT_SCHEMAS,
        ...SHARING_SCHEMAS,
        ...MAP_DETAIL_SCHEMAS,
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
          additionalProperties: false,
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
                    "Halo rim behind the text, 0 (none) to 3 (widest). " +
                    "Replaced the legacy " +
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
        ...LAYER_SCHEMAS,
        PublishedFieldsStatement: {
          type: "object",
          description:
            "Per-layer statement of the effective published field set" +
            ".",
          properties: {
            ...DOCUMENT_FACT_PROPERTIES,
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
                "vector tiles (a points-viz result over the render cap or " +
                "Bytes drawn per layer).",
            },
            geojson: {
              type: "object",
              description:
                "Inline GeoJSON. Feature properties are the columns the " +
                "audience reads: on a builder render, what the layer and " +
                "its map use; on a published render, the effective " +
                "published field set. Non-point features carry a reserved " +
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
                "render_bytes_exceeded, tiler_unavailable, " +
                "tile_build_failed, …) and is what " +
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
        EditRevisionResult: EDIT_REVISION_SCHEMA,
        PublishState: {
          allOf: [DOCUMENT_FACT_SCHEMA],
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
            ...DOCUMENT_FACT_PROPERTIES,
            token: {
              type: "string",
              description:
                "The published link's token, the map owner's alone: absent for anyone else who reaches the map.",
            },
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
    "x-resource-error-statuses": RESOURCE_ERROR_STATUSES,
  })));
}
