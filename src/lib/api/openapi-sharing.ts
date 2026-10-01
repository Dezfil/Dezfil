import { projectAccess } from "./openapi-project-access";
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

const PEOPLE_RULES =
  "A project's people are its owner and its members, each member a viewer or an editor. Everyone who reaches " +
  "the project reads them. Adding a person, changing a role and removing a person are the project owner's " +
  "alone: a member's attempt returns forbidden and an administrator gains nothing. A person is named by their " +
  "SQL name. A change governs the person's reach on their next request, with no sign-out. ";
const sqlNameParam = pathParam("sqlName", "The person's SQL name.");
const projectSubject = { path: "/api/projects/{id}", argument: "id", name: "name" };

export const SHARING_PATHS = {
  "/api/projects/{id}/people": {
    get: op(projectAccess({
      summary: "List a project's people",
      description: PEOPLE_RULES +
        "Answers the owner first, then the members by name, each with their display name, SQL name and role, " +
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
        "project's people as they now stand.",
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
