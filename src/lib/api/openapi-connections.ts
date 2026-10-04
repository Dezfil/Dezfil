import { FILING_DESTINATION } from "./openapi-project-access";
import { connectionAccess } from "./openapi-connection-access";
import { datasetAccess } from "./openapi-dataset-access";
import { ownedCreationOp } from "./openapi-owned-creation";
import { LOCAL_DELETE, LOCAL_READ, LOCAL_REPLACE, REMOTE_ADD, REMOTE_READ, REMOTE_REPLACE } from "./operation-mcp";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { op, jsonOk, pathParam } from "./openapi-helpers";

const PROTECTION_INPUT_CONTRACT =
  " Both string forms refuse unsupported protection parameters before source contact or " +
  "explicit-field overrides: nonempty ssl_min_protocol_version, ssl_max_protocol_version, " +
  "sslrootcert (including paths and system), sslcrl, sslcrldir, sslcert, sslkey, sslpassword, " +
  "require_auth, krbsrvname, gsslib, scram_client_key, scram_server_key, oauth_issuer, " +
  "oauth_client_id, oauth_client_secret and oauth_scope. Nonempty channel_binding and " +
  "gssencmode are refused except prefer/disable; sslcertmode except allow; sslsni except 1; " +
  "sslcompression and gssdelegation except 0/1; sslnegotiation except postgres; requiressl " +
  "except 0; string ssl except false (the JSON boolean is unchanged). These exceptions " +
  "and requirepeer are ignored, not forwarded or stored. Empty values are absent. " +
  "Every occurrence is checked after URI decoding or key-value unescaping; later empty " +
  "or permissive repeats cannot hide a refusal. The existing SSL-mode refusal wins; " +
  "otherwise the first refused parameter in input order is named. HTTP 400 invalid_request: " +
  "This connection string uses the unsupported protection parameter channel_binding; " +
  "Dezfil supports connection fields and SSL required or not required. For another " +
  "parameter, only its canonical name replaces channel_binding. No input value is echoed. " +
  "Refusal changes no stored fields, encrypted credential or health. Previously saved " +
  "connections retain their behavior: the original string was discarded, so its " +
  "protections cannot be recovered or checked retrospectively. A new string is validated. " +
  "Other omitted parameters keep their existing treatment, including options, service " +
  "and min_protocol_version; their omission is not a guarantee of harmlessness.";

export const CONNECTION_PATHS = {
  "/api/connections/postgis": {
    get: op(connectionAccess({
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
    })),
    post: ownedCreationOp(connectionAccess({
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
            "x-byte-limit": 16_777_216,
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
                    "Explicit fields override only a valid URL." + PROTECTION_INPUT_CONTRACT,
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
    })),
  },
  "/api/connections/postgis/{id}": {
    patch: op(connectionAccess({
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
            "x-byte-limit": 16_777_216,
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
                    "Absent mode retains the saved SSL setting on edit." + PROTECTION_INPUT_CONTRACT,
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
    })),
    delete: op(connectionAccess({
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
    })),
  },
  "/api/connections/postgis/{id}/test": {
    post: op(connectionAccess({
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
    })),
  },
  "/api/connections/postgis/{id}/tables": {
    get: op(connectionAccess({
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
    })),
  },
  "/api/connections/postgis/{id}/preview": {
    post: op(connectionAccess({
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
            "x-byte-limit": 16_777_216,
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
    })),
  },
  "/api/connections/postgis/{id}/snapshots": {
    get: op(connectionAccess({
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
    })),
  },
  "/api/imports/postgis": {
    post: ownedCreationOp(connectionAccess(datasetAccess({
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
            "x-byte-limit": 16_777_216,
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
                    "project refuses before the source is contacted." + FILING_DESTINATION,
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
    }))),
  },
};

export const CONNECTION_SCHEMAS = {
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
};
