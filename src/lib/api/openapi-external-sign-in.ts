import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_REPLACE } from "./operation-mcp";
import { resource, writes } from "./operation-metadata";
const origin = { name: "Origin", in: "header", required: true, schema: { type: "string" }, description: "Must match the trusted instance origin." };
export const EXTERNAL_SIGN_IN_PATHS = {
  "/api/auth/external/start": { post: { ...op({
    summary: "Start external sign-in", tag: "Accounts", tool: false, effects: writes(resource("accounts")),
    description: "Requires external sign-in mode and the trusted Origin. Sets an HttpOnly, SameSite=Lax, port-scoped start cookie for ten minutes and redirects the browser to the configured sign-in service with a start query parameter. Uses a process-signed value without allocating store rows; a restart invalidates starts in flight. Private, no-store, no-referrer.",
    parameters: [origin], responses: { "303": { description: "Continue at the configured sign-in service.", headers: { Location: { schema: { type: "string" } }, "Set-Cookie": { schema: { type: "string" } } } }, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: [] } },
  "/api/auth/external/arrive": { post: { ...op({
    summary: "Arrive with an external sign-in ticket", tag: "Accounts", tool: false, effects: writes(resource("accounts"), resource("assistant")),
    description: "Redeems a compact Ed25519 JWS bound to this browser's ten-minute start cookie and this instance's audience. A valid browser session is refused with already_signed_in and its account before any mutation or renewal. Accepted ticket ids are durable and single-use. Refusals charge only the source-address budget; account, budget, session and accepted id commit together on success. A higher door generation invalidates older credentials and interrupts older assistant work. The start cookie is cleared on success and refusal. Requires the trusted Origin and external sign-in mode. Private, no-store. The ticket is never an API or MCP credential.",
    parameters: [origin], requestBody: { "x-byte-limit": 8192, required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["ticket"], properties: { ticket: { type: "string", maxLength: 6144, writeOnly: true } } } } } },
    responses: { "200": jsonOk("#/components/schemas/AccountSession"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE, "409": ERROR_RESPONSE, "413": ERROR_RESPONSE, "429": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: [] } },
  "/api/instance/sign-out": { post: { ...op({
    summary: "Sign everyone out", tag: "Accounts", tool: "sign_everyone_out", toolInput: { closed: true },
    description: "Requires a current admin. Raises the sign-out generation, ending every account's browser sessions, API tokens and delegated credentials, including the caller's. Interrupts older assistant work and ends parked runs. Accounts, roles, memberships and identity bindings stay unchanged. Cookie requests require the same trusted Origin. Returns private, no-store.",
    effects: writes(resource("accounts"), resource("assistant")), mcp: LOCAL_REPLACE,
    display: { verb: "Signed everyone out" }, confirm: true,
    confirmation: { target: "Sign everyone out?", consequence: "Every session and API token of every account ends, your own included. Running assistant work stops and parked runs end.", subject: { path: null, argument: "", name: "" } },
    responses: { "200": jsonOk("#/components/schemas/AuthGenerations"), "401": ERROR_RESPONSE, "403": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
};
export const EXTERNAL_SIGN_IN_SCHEMAS = {
  AuthGenerations: { type: "object", additionalProperties: false, required: ["signOutGeneration", "doorGeneration"],
    properties: { signOutGeneration: { type: "integer", minimum: 0 }, doorGeneration: { type: "integer", minimum: 0 } } },
};
