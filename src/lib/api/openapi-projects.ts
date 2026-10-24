import { editRevisionResponses } from "./openapi-document-facts";
import { DOCUMENT_FACT_PROPERTIES, DOCUMENT_RESULTS_SCHEMA } from "./openapi-document-facts";
import { resultAccess } from "./openapi-result-access";
import { projectAccess } from "./openapi-project-access";
import { ownedCreationOp } from "./openapi-owned-creation";
import { PROJECT_EXPORT_TICKET } from "./openapi-tool-responses";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, LOCAL_TRANSIENT_READ, LOCAL_REPLACE } from "./operation-mcp";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { op, jsonOk, pathParam } from "./openapi-helpers";

/** The listings' project scope: shared by maps, tables and
 * recipes so the three doors say the same thing. */
export const PROJECT_SCOPE_PARAM = {
  name: "project",
  in: "query",
  required: false,
  schema: { type: "string" },
  description:
    "Narrow to one project's members by project id: any project the " +
    "caller reaches, its own or one shared with it, whoever owns what " +
    'is filed there; "none" narrows to the caller\'s own items filed ' +
    "in no project at all (one still filed in a project the caller no " +
    "longer reaches is not none). Omitted, everything the caller reaches " +
    "answers. An unknown or unreached project is not found, never an " +
    "empty list.",
};

export const PROJECT_PATHS = {
  "/api/projects": {
    get: op(projectAccess({
      summary: "List projects",
      description:
        "Every project the caller reaches, its own and those shared with it, with its member counts (maps, workflows as " +
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
    })),
    post: ownedCreationOp(projectAccess({
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
        "x-byte-limit": 16_777_216,
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
      responses: { ...editRevisionResponses,
        "201": jsonOk("#/components/schemas/ProjectCreated", "Created."),
      },
    })),
  },
  "/api/projects/{id}": {
    get: op(projectAccess({
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
    })),
    patch: op(projectAccess({
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
        "x-byte-limit": 16_777_216,
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
    })),
    delete: op(projectAccess({
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
                allOf: [DOCUMENT_RESULTS_SCHEMA],
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
    })),
  },
  "/api/projects/{id}/members": {
    get: op(projectAccess({
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
    })),
    patch: op(projectAccess({
      summary: "Change a project's members",
      description:
        "One atomic change: adds and removes for maps, " +
        "recipes and datasets together — everything applies or " +
        "nothing does. Only workflows can be project " +
        "members. Adding a map or eligible recipe moves it from any " +
        "previous project; adding a dataset adds another membership; " +
        "repeated adds are idempotent. Each part follows the filing " +
        "rules, so a caller may add only their own resources, and a " +
        "removal of what is not filed there changes nothing. An owner " +
        "who no longer reaches the project may still withdraw their " +
        "own resources from it; anyone else is answered as for an " +
        "unknown project. Answers the updated composite as the caller " +
        "reads it, empty for an owner who withdrew from a project they " +
        "do not reach.",
      tag: "Projects",
      tool: "update_project_members", mcp: LOCAL_REPLACE,
      display: {"verb": "Changed the members of the project {subject}", "subject": {"resource": "projects", "argument": "id", "name": ["name"]}},
      effects: writes(resource("projects", "id")),
      parameters: [pathParam("id", "Project id.")],
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ProjectMemberChange" },
            example: {
              addMaps: ["map-id"],
              expectedRevisions: { "map:map-id": "0123456789abcdef0123456789abcdef" },
              addTables: ["table-id-1", "table-id-2"],
            },
          },
        },
      },
      responses: { ...editRevisionResponses, "200": jsonOk("#/components/schemas/ProjectMembersChanged") },
    })),
  },
  "/api/projects/{id}/export": {
    post: op(resultAccess(projectAccess({
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
        "member. Every dataset has its own entry under the name the " +
        "exporter types for it, its qualifiedName: the plain name for " +
        "the exporter's own, <sql name>.<name> for another owner's, so " +
        "two people's same-named datasets never collide; the manifest " +
        "names each one's qualifiedName and owner and the exporter's " +
        "SQL name (exportedBy). Map and workflow documents carry their " +
        "SQL home, the account whose datasets their plain names mean. " +
        "No connection facts travel. The archive is assembled and finalized before any " +
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
        "x-byte-limit": 16_777_216,
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
    }))),
    get: op(resultAccess({
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
    })),
  },
};

export const PROJECT_DEPENDENCY_SCHEMAS = {
  DependencyDataset: {
    type: "object",
    description:
      "One dataset a map or workflow depends on — the facts both " +
      "filing checklists carry.",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      qualifiedName: {
        type: "string",
        description:
          "The name the caller would type: the plain name for the " +
          "caller's own dataset, <sql name>.<name> for another owner's.",
      },
      owner: { $ref: "#/components/schemas/Person" },
      owned: {
        type: "boolean",
        description:
          "True when the caller owns the dataset: a filing checklist " +
          "offers only these. Another person's dependency is listed as " +
          "not the caller's to add.",
      },
      source: { type: "string" },
      rowCount: { type: "integer" },
      projectIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Every project the dataset is in that the caller reaches, and " +
          "for the caller's own dataset every project it is in, one they " +
          "no longer reach included; order carries no meaning.",
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
          "The workflow-origin recipe a run of which recorded this " +
          "dataset as its output, when the caller reaches that " +
          "workflow; null otherwise.",
        properties: {
          ...DOCUMENT_FACT_PROPERTIES,
          id: { type: "string" },
          name: { type: "string" },
          owned: {
            type: "boolean",
            description: "True when the caller owns the workflow and so may file it.",
          },
        },
      },
    },
    required: [
      "id",
      "name",
      "qualifiedName",
      "owner",
      "owned",
      "source",
      "rowCount",
      "projectIds",
      "geometryColumn",
      "geometryType",
      "producer",
    ],
  },
};

export const PROJECT_SCHEMAS = {
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
      owner: {
        $ref: "#/components/schemas/Person",
        description: "The project's owner.",
      },
      role: {
        type: "string",
        enum: ["owner", "editor", "viewer"],
        description:
          "How the caller stands to the project: its owner, or one of " +
          "its people. A project with any role but owner is one shared " +
          "with the caller.",
      },
    },
    required: [
      "id",
      "name",
      "note",
      "owner",
      "role",
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
  ProjectCreated: { allOf: [{ $ref: "#/components/schemas/Project" }, DOCUMENT_RESULTS_SCHEMA] },
  ProjectMembersChanged: { allOf: [{ $ref: "#/components/schemas/ProjectMembers" }, DOCUMENT_RESULTS_SCHEMA] },
  ProjectMembers: {
    type: "object",
    description:
      "A project's members, each kind in its ordinary listing shape. " +
      "Project workflows are workflow-origin recipes.",
    properties: {
      maps: { $ref: "#/components/schemas/MapList" },
      recipes: {
        type: "array",
        items: { $ref: "#/components/schemas/Recipe" },
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
      expectedRevisions: {
        type: "object", additionalProperties: { type: "string", pattern: "^[0-9a-f]{32}$" },
        description: "Required for every named map and workflow, including no-op adds or removals. Keys are map:<id> or workflow:<id>; values are the editRevision paired with the caller’s read. Missing or malformed values answer 400; any stale value refuses the whole change with 409 stale_revision. Datasets need no revision.",
      },
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
};
