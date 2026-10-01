import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { READ_ONLY, resource, writes } from "./operation-metadata";

export const AUTH_SECURITY = [{ CookieSession: [] }, { BearerToken: [] }];
const accountPrecondition = " Optional X-Dezfil-Account asserts the credential's expected account ID. A mismatch returns 401 authentication_required before dispatch. This transport precondition never supplies identity or changes ownership.";
export const AUTH_SECURITY_SCHEMES = {
  CookieSession: { type: "apiKey", in: "cookie", name: "dezfil_session", description: "HttpOnly, SameSite=Lax session. Secure over HTTPS. Thirty days, rolling with use." + accountPrecondition },
  BearerToken: { type: "http", scheme: "bearer", description: "An account's API token. Its current account status and privileges are checked on every request." + accountPrecondition },
};
const body = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties, required } } },
});
const password = { type: "string", minLength: 8, writeOnly: true, description: "At least eight characters; very common passwords are refused. No character classes are required." };
const email = { type: "string", description: "Local email identity, normalized for case and surrounding whitespace." };
const success = { "200": jsonOk("#/components/schemas/AccountSession"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "409": ERROR_RESPONSE, "503": ERROR_RESPONSE };
const entry = "Cookie mutations and entry submissions require an Origin matching the trusted request origin. Explicit bearer authentication does not use cookies. Responses are private, no-store. ";
const mutation = (summary: string, description: string, properties: Record<string, unknown>) => ({ ...op({ summary, description: entry + description, tag: "Accounts", tool: false,
  effects: writes(resource("accounts")), requestBody: body(properties), responses: success }), security: [] });
export const AUTH_PATHS = {
  "/api/auth/entry": { get: { ...op({ summary: "Authentication entry information", tag: "Accounts", tool: false, effects: READ_ONLY,
    description: "Only the instance name and setup availability. Before setup, the legacy display name may prefill Name. Never returns a signed-in person's identity or other settings. Private, no-store.",
    responses: { "200": jsonOk("#/components/schemas/AuthEntry"), "503": ERROR_RESPONSE } }), security: [] } },
  "/api/auth/setup": { post: mutation("Create the first account", "Atomically creates the sole initial admin, adopts legacy preferences and establishes a cookie session. Once any account exists, setup_complete refuses further creation.", { name: { type: "string" }, email, password }) },
  "/api/auth/sign-in": { post: { ...mutation("Sign in", "Unknown email and wrong password share invalid_credentials. Valid credentials for a deactivated account return account_deactivated. Account failure limits apply only to sources with recent failures; a correct password from a source without recent failures can sign in even when the account budget is exhausted. Failures from every source count against the account, and source limits always apply. Limits return rate_limited with Retry-After, retryAfter seconds and retryAt (ISO timestamp); waiting restores admission.", { email, password: { type: "string", writeOnly: true } }),
    responses: { ...success, "429": { ...ERROR_RESPONSE, headers: { "Retry-After": { description: "Seconds until another attempt is permitted.", schema: { type: "integer", minimum: 1 } } } } } } },
  "/api/auth/redeem": { post: mutation("Redeem a sign-in link", "An admin-issued link expires after seven days and is consumed once. Invalid, expired, replaced and reused links return invalid_link without changing the password or session. Success replaces the browser's cookie with the recipient's session, even when another account was signed in.", { secret: { type: "string", writeOnly: true }, password }) },
  "/api/auth/session": { get: { ...op({ summary: "Read your current session identity", tag: "Accounts", tool: false, effects: READ_ONLY,
    description: "Rechecks the presented cookie or bearer against current account and credential state. Invalid or revoked credentials return authentication_required. Private, no-store.",
    responses: { "200": jsonOk("#/components/schemas/AccountSession"), "401": ERROR_RESPONSE, "503": ERROR_RESPONSE } }), security: AUTH_SECURITY } },
  "/api/auth/sign-out": { post: { ...op({ summary: "Sign out", tag: "Accounts", tool: false, effects: writes(resource("accounts")),
    description: entry + "Ends the current browser session and clears its cookie. A bearer has no browser session to end; API tokens are revoked through their own controls.",
    responses: { "200": jsonOk("#/components/schemas/SignedOut"), "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE } }), security: AUTH_SECURITY } },
};
export const AUTH_SCHEMAS = {
  Account: { type: "object", additionalProperties: false,
    properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" },
      sqlName: { type: "string", pattern: "^[a-z][a-z0-9_]{2,31}$", description: "The account's SQL name, unique on the instance. Derived from the display name (else the email's local part, else the word user, with a number added on a collision or a name the query engine reserves) when the account is created or upgraded, and fixed thereafter: changing the name or email never changes it." },
      isAdmin: { type: "boolean" },
      status: { type: "string", enum: ["invited", "active", "deactivated"] }, isOriginal: { type: "boolean" },
      createdAt: { type: "string" }, updatedAt: { type: "string" }, lastSignInAt: { type: ["string", "null"] } },
    required: ["id", "name", "email", "sqlName", "isAdmin", "status", "isOriginal", "createdAt", "updatedAt", "lastSignInAt"] },
  AccountSession: { type: "object", properties: { account: { $ref: "#/components/schemas/Account" } }, required: ["account"], additionalProperties: false },
  AuthEntry: { type: "object", properties: { instanceName: { type: ["string", "null"] }, setupRequired: { type: "boolean" }, prefillName: { type: "string" } }, required: ["instanceName", "setupRequired"], additionalProperties: false },
  SignedOut: { type: "object", properties: { signedOut: { type: "boolean", const: true } }, required: ["signedOut"], additionalProperties: false },
};
