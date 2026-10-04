import { editRevisionParam, editRevisionResponses } from "./openapi-document-facts";
import { DOCUMENT_FACT_PROPERTIES } from "./openapi-document-facts";
import { projectAccess } from "./openapi-project-access";
import { mapAccess } from "./openapi-map-access";
import { workflowAccess } from "./openapi-workflow-access";
import { authenticatedOp } from "./openapi-authenticated";
import { DIRECTORY_LIMIT, DIRECTORY_QUERY_MAX } from "@/lib/auth/directory-bounds";
import { ERROR_RESPONSE, jsonOk, op, pathParam } from "./openapi-helpers";
import { LOCAL_DELETE, LOCAL_READ, type McpConsequences } from "./operation-mcp";
import { READ_ONLY, resource, writes } from "./operation-metadata";

/**
 * Sharing a project: its people, and the routes that change who holds what.
 * Each route here is the API the share dialog calls, documented once and
 * generated as its tool.
 */

/** Setting a role twice leaves the same people as setting it once. */
const LOCAL_SET: McpConsequences = { destructiveHint: true, openWorldHint: false, idempotentHint: true };
/** A repeated transfer is refused: the caller is no longer the owner. */
const TRANSFER: McpConsequences = { destructiveHint: true, openWorldHint: false, idempotentHint: false };

const PEOPLE_RULES =
  "A project's people are its owner and its members, each member a viewer or an editor. The project's owner " +
  "reads them all; anyone else who reaches the project reads the owner and themselves alone, with their own " +
  "role. Adding a person, changing a role and removing a person are the project owner's " +
  "alone: a member's attempt returns forbidden and an administrator gains nothing. A person is named by their " +
  "SQL name. A change governs the person's reach on their next request, with no sign-out. ";
const sqlNameParam = pathParam("sqlName", "The person's SQL name.");
const projectSubject = { path: "/api/projects/{id}", argument: "id", name: "name" };

const TRANSFER_RULES =
  "Transfer is the only change of ownership any operation makes, and it is always the current owner's own " +
  "act. The new owner is named by their SQL name and must be an active account. The owner's authority, the " +
  "recipient, the ownership change and everything that moves with it commit together, or nothing changes. " +
  "Datasets and connections have no transfer. ";
/** A filed resource's transfer: to its project's owner or one of its people. */
const filedTransfer = (noun: string, keeps: string) => TRANSFER_RULES +
  `Makes another active person who already reaches the ${noun} its owner: the owner of the project it is ` +
  `filed in, or one of that project's people. An unfiled ${noun} is refused with invalid_request: file the ` +
  `${noun} in a project first. The ${noun} keeps its SQL home, so its SQL means what it meant, and ${keeps}. ` +
  "Anyone else who reaches it is refused with forbidden. A recipient who is deactivated, not yet redeemed, " +
  "unknown, the owner, or does not reach it is refused with invalid_request, and nothing changes. Answers the " +
  `${noun}'s identity and its new owner.`;
const transferBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { to: { type: "string", minLength: 1, description: "The new owner's SQL name." } },
        required: ["to"],
      },
      example: { to: "ada" },
    },
  },
};
const TRANSFERRED = { "200": jsonOk("#/components/schemas/Transfer"), "400": ERROR_RESPONSE };

const PEOPLE_PATHS = {
  "/api/projects/{id}/people": {
    get: op(projectAccess({
      summary: "List a project's people",
      description: PEOPLE_RULES +
        "Answers the owner first, then the members by name (to a member, themselves), each with their display name, SQL name and role, " +
        "and marked deactivated while their account is: a deactivated member keeps their place with their " +
        "grant inert until reactivation. Never an email or an account identity.",
      tag: "Projects",
      tool: "list_project_people", mcp: LOCAL_READ,
      display: { verb: "Read the people of the project {subject}", subject: { resource: "projects", argument: "id" } },
      effects: READ_ONLY,
      parameters: [pathParam("id", "Project id.")],
      responses: { "200": jsonOk("#/components/schemas/ProjectPeople") },
    })),
  },
  "/api/projects/{id}/people/{sqlName}": {
    put: op(projectAccess({
      summary: "Give a person a role on a project",
      description: PEOPLE_RULES +
        "Adds the person with the role, or changes the role they hold. Only an active account other than the " +
        "project's owner can hold a role: the owner is never its own member (invalid_request), and a " +
        "deactivated account, an invitation not yet redeemed and an unknown SQL name are refused alike with " +
        "invalid_request and the sentence \"No active person has that SQL name.\" A viewer opens everything " +
        "filed in the project; an editor can also change its maps and workflows and file their own work " +
        "there. Answers the project's people as they now stand. While the owner's account is deactivated " +
        "nobody can change the people.",
      tag: "Projects",
      tool: "set_project_person", mcp: LOCAL_SET,
      display: { verb: "Gave {arg.sqlName} the {arg.role} role on the project {subject}",
        subject: { resource: "projects", argument: "id" } },
      effects: writes(resource("projects", "id")),
      confirm: true,
      confirmation: { target: "Change who can reach {target}?",
        consequence: "The role applies on their next request: a viewer opens everything filed in the project, and an editor can also change its maps and workflows.",
        subject: projectSubject },
      parameters: [pathParam("id", "Project id."), sqlNameParam],
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { role: { type: "string", enum: ["viewer", "editor"] } },
              required: ["role"],
            },
            example: { role: "editor" },
          },
        },
      },
      responses: { "200": jsonOk("#/components/schemas/ProjectPeople"), "400": ERROR_RESPONSE },
    })),
    delete: op(projectAccess({
      summary: "Remove a person from a project",
      description: PEOPLE_RULES +
        "Takes the person off the project, a deactivated member included; removing someone who holds no " +
        "role there changes nothing. Nothing the person owns is deleted, unfiled or reassigned. Answers the " +
        "project's people as they now stand. While the owner's account is deactivated nobody can change the people.",
      tag: "Projects",
      tool: "remove_project_person", mcp: LOCAL_DELETE,
      display: { verb: "Removed {arg.sqlName} from the project {subject}",
        subject: { resource: "projects", argument: "id" } },
      effects: writes(resource("projects", "id")),
      confirm: true,
      confirmation: { target: "Remove this person from {target}?",
        consequence: "They lose what this project gave them on their next request. Nothing they own is deleted.",
        subject: projectSubject },
      parameters: [pathParam("id", "Project id."), sqlNameParam],
      responses: { "200": jsonOk("#/components/schemas/ProjectPeople") },
    })),
  },
};

const TRANSFER_PATHS = {
  "/api/projects/{id}/transfer": {
    post: op(projectAccess({
      summary: "Transfer a project to one of its members",
      description: TRANSFER_RULES +
        "Makes one of the project's active members its owner: the recipient leaves the member list and the " +
        "previous owner becomes an editor. The project keeps its name, note, other people and contents, and " +
        "everything filed in it keeps its own owner. The project owner's alone: a member's attempt returns " +
        "forbidden. A recipient who is not an active member (a deactivated member, someone outside the " +
        "project, an unknown SQL name, the owner) is refused with invalid_request, and nothing changes. While " +
        "the owner's account is deactivated nobody can transfer it. Answers the project's identity and its " +
        "new owner.",
      tag: "Projects",
      tool: "transfer_project", mcp: TRANSFER,
      display: { verb: "Transferred the project {subject} to {arg.to}", subject: { resource: "projects", argument: "id" } },
      effects: writes(resource("projects", "id")),
      confirm: true,
      confirmation: { target: "Make someone else the owner of {target}?",
        consequence: "They take over its people, sharing and deletion, and you stay on as an editor. Only they can give it back.",
        subject: projectSubject },
      parameters: [pathParam("id", "Project id.")],
      requestBody: { ...transferBody, "x-byte-limit": 16_777_216 },
      responses: TRANSFERRED,
    })),
  },
  "/api/maps/{id}/transfer": {
    post: op(mapAccess({
      summary: "Transfer a map to someone who reaches it",
      description: filedTransfer("map", "it keeps its layers, history, card images and its publication, " +
        "which becomes the new owner's and renders with the new owner's reach: a dataset the new owner cannot " +
        "reach fails on the link rather than drawing anything else"),
      tag: "Maps",
      tool: "transfer_map", mcp: TRANSFER,
      relevance: [],
      display: { verb: "Transferred the map {subject} to {arg.to}", subject: { resource: "maps", argument: "id" } },
      effects: writes(resource("maps", "id")),
      confirm: true,
      confirmation: { target: "Make someone else the owner of {target}?",
        consequence: "Its publication, deletion and transfer become theirs, and its SQL home stays as it is. Only they can give it back.",
        subject: { path: "/api/maps/{id}", argument: "id", name: "name" } },
      parameters: [editRevisionParam, pathParam("id", "Map id.")],
      requestBody: { ...transferBody, "x-byte-limit": 16_777_216 },
      responses: { ...editRevisionResponses, ...TRANSFERRED, "200": jsonOk("#/components/schemas/DocumentTransfer") },
    })),
  },
  "/api/recipes/{id}/transfer": {
    post: op(workflowAccess({
      summary: "Transfer a workflow to someone who reaches it",
      description: filedTransfer("workflow", "it keeps its steps, layout and run history, while every run's " +
        "outputs stay with the person who ran it"),
      tag: "Recipes",
      tool: "transfer_workflow", mcp: TRANSFER,
      relevance: [],
      display: { verb: "Transferred the workflow {subject} to {arg.to}", subject: { resource: "recipes", argument: "id" } },
      effects: writes(resource("recipes", "id")),
      confirm: true,
      confirmation: { target: "Make someone else the owner of {target}?",
        consequence: "Its deletion and transfer become theirs, and its SQL home and run history stay as they are. Only they can give it back.",
        subject: { path: "/api/recipes/{id}", argument: "id", name: "recipe.name" } },
      parameters: [editRevisionParam, pathParam("id", "Workflow id.")],
      requestBody: { ...transferBody, "x-byte-limit": 16_777_216 },
      responses: { ...editRevisionResponses, ...TRANSFERRED, "200": jsonOk("#/components/schemas/DocumentTransfer") },
    })),
  },
};

const DIRECTORY_PATHS = {
  "/api/accounts/search": {
    get: authenticatedOp({
      summary: "Find people to share with",
      description:
        "The directory of active people, for sharing a project: any signed-in account can find other active " +
        "accounts by any part of their display name (case-insensitive, the query trimmed) or by their exact " +
        "email (trimmed, case-insensitive), never by part of one. This is the one deliberate exception to " +
        "account reads being admin-only, and it is minimal: each result carries the person's display name and " +
        "SQL name and nothing else, never an email, an admin flag or an account identity. Deactivated accounts " +
        "and invitations not yet redeemed are never offered, nor the caller's own account, and nobody answers " +
        `twice. An empty query answers nobody; at most ${DIRECTORY_LIMIT} people answer, an exact email ` +
        "match first, then by display name. The SQL name is how the sharing operations name the person. " +
        "Managing accounts stays admin-only.",
      tag: "Accounts",
      tool: "find_accounts", mcp: LOCAL_READ,
      display: { verb: "Looked for people matching {arg.q}" },
      effects: READ_ONLY,
      parameters: [{
        name: "q", in: "query", required: true,
        schema: { type: "string", maxLength: DIRECTORY_QUERY_MAX },
        description: "Part of a display name, or an exact email.",
      }],
      responses: { "200": jsonOk("#/components/schemas/AccountDirectory"), "400": ERROR_RESPONSE },
    }),
  },
};

export const SHARING_PATHS = { ...PEOPLE_PATHS, ...TRANSFER_PATHS, ...DIRECTORY_PATHS };

export const SHARING_SCHEMAS = {
  ProjectPerson: {
    type: "object",
    description: "One of a project's people: never an email or an account identity.",
    properties: {
      name: { type: "string", description: "The person's display name." },
      sqlName: { type: "string", description: "The person's SQL name, which names them on every sharing operation." },
      role: { type: "string", enum: ["owner", "editor", "viewer"] },
      deactivated: {
        type: "boolean",
        description: "The account is deactivated: a member's grant is inert until reactivation, and the owner can remove them.",
      },
    },
    required: ["name", "sqlName", "role", "deactivated"],
  },
  DirectoryPerson: {
    type: "object",
    additionalProperties: false,
    description: "A person the directory offers: their display name and SQL name, nothing else.",
    properties: {
      name: { type: "string", description: "The person's display name." },
      sqlName: { type: "string", description: "The person's SQL name, which names them on every sharing operation." },
    },
    required: ["name", "sqlName"],
  },
  AccountDirectory: {
    type: "object",
    properties: {
      accounts: {
        type: "array",
        maxItems: DIRECTORY_LIMIT,
        description: "An exact email match first, then by display name.",
        items: { $ref: "#/components/schemas/DirectoryPerson" },
      },
    },
    required: ["accounts"],
  },
  DocumentTransfer: { allOf: [{ $ref: "#/components/schemas/Transfer" }], type: "object",
    properties: { editRevision: { ...DOCUMENT_FACT_PROPERTIES.editRevision, description: "Resulting revision, present only while the caller still reaches the transferred document." } } },
  Transfer: {
    type: "object",
    description: "A completed transfer: the resource's identity and its new owner.",
    properties: {
      id: { type: "string" },
      owner: { $ref: "#/components/schemas/ResourceOwner", description: "The new owner." },
    },
    required: ["id", "owner"],
  },
  ProjectPeople: {
    type: "object",
    properties: {
      people: {
        type: "array",
        description: "The owner first, then the members by name.",
        items: { $ref: "#/components/schemas/ProjectPerson" },
      },
    },
    required: ["people"],
  },
};
