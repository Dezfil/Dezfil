import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op, pathParam } from "./openapi-helpers";
import { LOCAL_DELETE, LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { READ_ONLY, resource, writes } from "./operation-metadata";
import { PICTURE_VERSION_PROPERTY } from "./openapi-picture-version";

const CACHED = "private, no-cache";
const OWN =
  "Requires a current cookie session or bearer token; a cookie-signed request needs the instance's Origin. " +
  "Responses, including refusals, are private, no-store. It acts on the signed-in account's own picture, " +
  "never another's, and an account whose deletion has been accepted is refused before anything is read. ";
const ORDER =
  "Writes to one account's picture take effect in the order they were admitted: a change overtaken by one " +
  "admitted after it changes nothing and answers the account as it stands. ";
const MCP_PICTURE =
  "Through MCP the file travels as base64 in content_base64; a file of the full 10,485,760 bytes fits the " +
  "16,777,216-byte envelope.";
const writeErrors = { "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE };

export const PROFILE_PICTURE_PATHS = {
  "/api/account/picture": {
    put: {
      ...op({
        summary: "Set your picture",
        description: OWN +
          "multipart/form-data with exactly one file part named `file`: a still JPEG, PNG or WebP image, " +
          "recognised by its content whatever its name or declared type. The file is at most 10,485,760 " +
          "bytes (10 MB, a fixed limit) and the whole body at most 65,536 bytes more, counted as they arrive " +
          "whatever length is declared: one byte over answers 413 upload_too_large. An SVG, a GIF, an " +
          "animated image, or one that is damaged or incomplete, answers 415 unsupported_image; more than " +
          "64 million pixels, read from the header before any pixel is decoded, 413 image_too_large. The " +
          "body has 120 seconds to arrive: one still arriving then answers 408 data_processing_timeout, and one " +
          "that sends no body byte for 60 seconds answers 408 upload_stalled. The first refusal is delivered without waiting for the rest of the " +
          "body, and the refused connection closes within five seconds. A caller who leaves before the body " +
          "is received changes nothing. Processing takes at most 20 seconds, waiting included, and runs " +
          "one picture at a time on the instance with eight more waiting; past that, 503 " +
          "operation_queue_full. The server keeps its own copy: turned the way its orientation says, the " +
          "largest centred square scaled to 320 pixels, a WebP with transparency kept and every embedded " +
          "record dropped. " + ORDER + "A refusal or failure leaves the current picture. Answers the " +
          "account, its new pictureVersion included. " + MCP_PICTURE,
        tag: "Accounts",
        tool: "set_account_picture", mcp: LOCAL_REPLACE,
        toolInput: { multipart: { field: "file", filename: "filename", content: "content_base64" } },
        display: { verb: "Set your picture" },
        effects: writes(resource("accounts")),
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary", description: "A still JPEG, PNG or WebP image of at most 10,485,760 bytes. " + MCP_PICTURE } },
                required: ["file"],
              },
            },
          },
        },
        responses: {
          "200": jsonOk("#/components/schemas/AccountSession"),
          ...writeErrors,
          "408": ERROR_RESPONSE,
          "413": ERROR_RESPONSE,
          "415": ERROR_RESPONSE,
        },
      }),
      security: AUTH_SECURITY,
    },
    delete: {
      ...op({
        summary: "Remove your picture",
        description: OWN + "Your initials stand in again; removing when there is no picture changes nothing. " +
          ORDER + "Answers the account, without a pictureVersion.",
        tag: "Accounts",
        tool: "remove_account_picture", mcp: LOCAL_DELETE,
        display: { verb: "Removed your picture" },
        effects: writes(resource("accounts")),
        responses: { "200": jsonOk("#/components/schemas/AccountSession"), ...writeErrors },
      }),
      security: AUTH_SECURITY,
    },
  },
  "/api/users/{id}/picture": {
    delete: {
      ...op({
        summary: "Remove a person's picture",
        description:
          "Requires a current admin account through a cookie session or bearer token. Cookie mutations " +
          "require the same trusted Origin. Responses, including refusals, are private, no-store. Removes " +
          "the account's picture, a deactivated account's included; its initials stand in again, and " +
          "removing when there is none changes nothing. An admin removes a picture and never sets one: " +
          "no operation sets another account's picture. An account whose deletion has been accepted, or " +
          "an unknown one, answers 404 not_found, and a caller who is not an admin, or no longer one when " +
          "the change commits, 403 forbidden; either way the picture stays. " + ORDER + "Answers the account.",
        tag: "Accounts",
        tool: "remove_user_picture", mcp: LOCAL_DELETE,
        display: { verb: "Removed the picture of {subject}", subject: { resource: "accounts", argument: "id" } },
        confirm: true,
        confirmation: {
          target: "Remove the picture of {target}?",
          consequence: "Their initials show in its place. They can set a new picture themselves.",
          subject: { path: "/api/users", argument: "id", name: "name", collection: "users", identity: "id" },
        },
        effects: writes(resource("accounts", "id")),
        parameters: [pathParam("id", "The account's id.")],
        responses: { "200": jsonOk("#/components/schemas/AccountSession"), ...writeErrors, "404": ERROR_RESPONSE },
      }),
      security: AUTH_SECURITY,
    },
  },
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
