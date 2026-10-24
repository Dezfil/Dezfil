import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, op, pathParam } from "./openapi-helpers";
import { LOCAL_READ } from "./operation-mcp";
import { READ_ONLY } from "./operation-metadata";
import { PICTURE_VERSION_PROPERTY } from "./openapi-picture-version";

const CACHED = "private, no-cache";

export const PROFILE_PICTURE_PATHS = {
  "/api/accounts/{sqlName}/picture": {
    get: {
      ...op({
        summary: "Read a person's picture",
        description:
          "Requires a current cookie session or bearer token. Any active account reads any person's current " +
          "picture, with or without a shared project: the people the account, Users, directory, project " +
          "people and owner reads name, a deactivated person included. The picture is a WebP, 320 pixels " +
          "square, the server's own copy with no embedded records. `v` names the version a read gave: the " +
          "current version is served, an earlier one answers 404, and without `v` the current picture is " +
          "served. A person with no picture, under deletion or unknown answers the same 404. Every answer " +
          "carries an entity tag of its bytes and `Cache-Control: private, no-cache`, so a client may keep it " +
          "but asks again before each use; a request whose `If-None-Match` names the current tag is answered " +
          "304 without the bytes, after the same checks as a full read. Refusals are private, no-store. " +
          "Agents receive the image as an attachment.",
        tag: "Accounts",
        tool: "read_account_picture", mcp: LOCAL_READ,
        toolOutput: { binary: { representation: "attachment", nativeImage: true } },
        display: { verb: "Read the picture of {arg.sqlName}" },
        effects: READ_ONLY,
        parameters: [
          pathParam("sqlName", "The person's SQL name."),
          { name: "v", in: "query", required: false, schema: { type: "string" }, description: "The picture version a read gave (pictureVersion); absent reads the current picture." },
        ],
        responses: {
          "200": {
            description: "The picture, as an attachment.",
            headers: {
              ETag: { description: "The entity tag of these bytes.", schema: { type: "string" } },
              "Cache-Control": { description: CACHED, schema: { type: "string", const: CACHED } },
              "Content-Disposition": { description: "attachment, named <sqlName>.webp", schema: { type: "string" } },
            },
            content: { "image/webp": { schema: { type: "string", format: "binary" } } },
          },
          "304": { description: "The picture is unchanged: its entity tag matches If-None-Match." },
          "401": ERROR_RESPONSE,
          "403": ERROR_RESPONSE,
          "404": { ...ERROR_RESPONSE, description: "No picture at this address: none, an earlier version, a person under deletion or nobody by that SQL name (not_found)." },
          "503": ERROR_RESPONSE,
        },
      }),
      security: AUTH_SECURITY,
    },
  },
};

export const PROFILE_PICTURE_SCHEMAS = {
  Person: {
    type: "object",
    description:
      "A person a resource names where the app draws their face, such as " +
      "its owner. The display name, the SQL name and the picture's " +
      "version, never an email.",
    properties: {
      name: { type: "string" },
      sqlName: {
        type: "string",
        description: "The person's SQL name, the qualifier other people's SQL uses for their datasets.",
      },
      pictureVersion: PICTURE_VERSION_PROPERTY,
    },
    required: ["name", "sqlName"],
  },
};
