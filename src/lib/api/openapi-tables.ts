import { FILING_DESTINATION } from "./openapi-project-access";
import { datasetAccess } from "./openapi-dataset-access";
import { ownedCreationOp } from "./openapi-owned-creation";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, REMOTE_REPLACE } from "./operation-mcp";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { op, jsonOk, pathParam } from "./openapi-helpers";
import { GEOMETRY_REFRESH_DESCRIPTION } from "./openapi-geometry-resource";
import { CSV_GEOMETRY_DESCRIPTION } from "./openapi-geometry";
import { PROJECT_SCOPE_PARAM } from "./openapi-projects";

export const TABLE_COLLECTION_PATHS = {
  "/api/tables": {
    get: op(datasetAccess({
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
    })),
    post: ownedCreationOp(datasetAccess({
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
            "unknown project refuses before the upload is received." + FILING_DESTINATION,
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
    })),
  },
};

export const TABLE_RESOURCE_PATHS = {
  "/api/tables/{name}/refresh": {
    post: op(datasetAccess({
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
            "x-byte-limit": 16_777_216,
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
    })),
  },
  "/api/tables/{name}/features": {
    get: op(datasetAccess({
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
    })),
  },
  "/api/tables/{name}/export": {
    get: op(datasetAccess({
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
    })),
  },
  "/api/tables/{name}": {
    get: op(datasetAccess({
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
    })),
    delete: op(datasetAccess({
      summary: "Delete a table",
      tag: "Tables",
      tool: "delete_table", mcp: LOCAL_DELETE,
      display: {"verb": "Deleted the dataset {subject}", "subject": {"resource": "tables", "argument": "name"}},
      effects: writes(resource("tables", "name"), resource("projects")),
      confirmation: {"target": "Delete {target}?", "consequence": "This deletes the dataset and its data. Layers that read it will lose their source.", "subject": {"path": "/api/catalogue/tables?names={name}", "argument": "name", "name": "name", "collection": "tables", "identity": "name"}},
      confirm: true,
      parameters: [pathParam("name", "Table name.")],
      responses: { "204": { description: "Deleted." } },
    })),
  },
};

export const TABLE_SCHEMAS = {
  Table: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      qualifiedName: {
        type: "string",
        description:
          "The name the caller would type for this dataset: its plain " +
          "name when it is the caller's own, <sql name>.<name> when it " +
          "is another owner's, which tells two same-named datasets " +
          "apart. Present on every listing and read.",
      },
      owner: {
        $ref: "#/components/schemas/ResourceOwner",
        description: "The dataset's owner. Present on every listing and read.",
      },
      sourceFilename: {
        type: ["string", "null"],
        description:
          "The file this table arrived as. Null for a derived " +
          "table, whose output never was a file, and, to anyone but " +
          "its owner, for a PostGIS snapshot, whose remote schema and " +
          "table belong to its owner's connection.",
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
          "As stored for the caller's own dataset. For another owner's, " +
          "null when it would name a connection (a PostGIS snapshot shows " +
          "its source kind and nothing more) or a map the caller does not " +
          "reach. " +
          "For another owner's derived dataset, `inputs` lists only the " +
          "inputs the caller reaches; its `sql` and `parameters` are as stored. " +
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
          "now carries its name. Resolved within the caller's reach: " +
          "the dataset's owner reads an input they no longer reach as " +
          "missing, exactly as a deleted one; anyone else reads only " +
          "the inputs they reach.",
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
          "The projects this dataset is in that the caller reaches, and " +
          "for the caller's own dataset every project it is in, one they " +
          "no longer reach included (they withdraw it with PATCH " +
          "/api/projects/{id}/members); empty = in no project. A dataset " +
          "can be in several; the order carries no meaning.",
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
};

export const TABLE_INSPECTION_SCHEMAS = {
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
};
