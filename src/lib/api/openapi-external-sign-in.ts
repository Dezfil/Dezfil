import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_REPLACE } from "./operation-mcp";
import { resource, writes } from "./operation-metadata";
export const EXTERNAL_SIGN_IN_PATHS = {
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
