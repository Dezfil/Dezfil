import { AUTH_SECURITY, AUTHENTICATION_BUSY_RESPONSE, DERIVATION_ADMISSION } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op, pathParam } from "./openapi-helpers";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { READ_ONLY, resource, writes } from "./operation-metadata";

const privacy = "Cookie or bearer authentication is required. Cookie mutations require the same trusted Origin. Responses, including refusals, are private, no-store. ";
const errors = { "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE };
const body = (properties: Record<string, unknown>, required = Object.keys(properties), extra = {}) => ({
  "x-byte-limit": 65_536, required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties, required, ...extra } } },
});
const currentPassword = { type: "string", writeOnly: true, description: "Your current password." };
const ownSubject = { path: "/api/account", argument: "", name: "account.name" };
export const ACCOUNT_PATHS = {
  "/api/account": {
    get: { ...op({ summary: "Read your account", description: privacy + "Returns only the authenticated account's profile. No password or credential material is returned.",
      tag: "Accounts", tool: "get_account", effects: READ_ONLY, mcp: LOCAL_READ, display: { verb: "Read your account" },
      responses: { "200": jsonOk("#/components/schemas/AccountSession"), ...errors } }), security: AUTH_SECURITY },
    patch: { ...op({ summary: "Update your account", description: DERIVATION_ADMISSION + privacy + "Changes only your own name or email. An email change requires currentPassword and replaces the sign-in email. Duplicate emails return email_taken, regardless of case or surrounding whitespace. Missing or incorrect current passwords return current_password_required. The complete patch is validated before any write; account identity, role and status cannot be submitted.",
      tag: "Accounts", tool: "update_account", effects: writes(resource("accounts")), mcp: LOCAL_REPLACE, display: { verb: "Updated your account" },
      requestBody: body({ name: { type: "string", minLength: 1, maxLength: 80 }, email: { type: "string" }, currentPassword }, [], { anyOf: [{ required: ["name"] }, { required: ["email"] }] }),
      responses: { "200": jsonOk("#/components/schemas/AccountSession"), ...errors, "503": AUTHENTICATION_BUSY_RESPONSE, "409": ERROR_RESPONSE } }), security: AUTH_SECURITY },
  },
  "/api/account/password": { post: { ...op({ summary: "Change your password", description: DERIVATION_ADMISSION + privacy + "Requires currentPassword. The new password needs at least eight characters and cannot be very common; no character classes are required. Wrong current passwords return current_password_required; weak new passwords return weak_password. Keeps the calling browser session, ends your other sessions and leaves API tokens valid. A bearer caller has no browser session to preserve.",
    tag: "Accounts", tool: "change_password", effects: writes(resource("accounts")), mcp: LOCAL_REPLACE, display: { verb: "Changed your password" }, confirm: true,
    confirmation: { target: "Change your password?", consequence: "Your other browser sessions will end. API tokens stay valid.", subject: ownSubject },
    requestBody: body({ currentPassword, password: { type: "string", minLength: 8, writeOnly: true } }),
    responses: { "200": jsonOk("#/components/schemas/PasswordChanged"), ...errors, "503": AUTHENTICATION_BUSY_RESPONSE } }), security: AUTH_SECURITY } },
  "/api/account/tokens": {
    get: { ...op({ summary: "List your API tokens", description: privacy + "Lists only your own tokens, including revoked and expired ones, each with when it expires. Secrets and hashes are never returned.",
      tag: "Accounts", tool: "list_api_tokens", effects: READ_ONLY, mcp: LOCAL_READ, display: { verb: "Read your API tokens" },
      responses: { "200": jsonOk("#/components/schemas/ApiTokens"), ...errors } }), security: AUTH_SECURITY },
    post: { ...op({ summary: "Create an API token", description: privacy + "Creates a named API/MCP token for your own account. The secret is returned only on creation. It authenticates with your current account permissions and is refused while the account is deactivated. It lasts as long as the instance's rule for new tokens said at its creation, or never expires; expiresAt says when, a later change of the rule moves no token's expiry, and once it passes the token is refused with token_expired.",
      tag: "Accounts", tool: "create_api_token", effects: writes(resource("accounts")), mcp: LOCAL_ADD, display: { verb: "Created an API token" }, confirm: true,
      confirmation: { target: "Create an API token for your account?", consequence: "The token grants your current permissions until it is revoked or expires, or the account is deactivated.", subject: ownSubject },
      requestBody: body({ name: { type: "string", minLength: 1 } }),
      responses: { "201": jsonOk("#/components/schemas/CreatedApiToken"), ...errors } }), security: AUTH_SECURITY },
  },
  "/api/account/tokens/{id}": { delete: { ...op({ summary: "Revoke your API token", description: privacy + "Permanently refuses this token on later requests. Only your own tokens can be revoked; unknown or other-account IDs return not_found without changes. Repeated revocation is harmless.",
    tag: "Accounts", tool: "revoke_api_token", effects: writes(resource("accounts")), mcp: LOCAL_DELETE, display: { verb: "Revoked an API token" }, confirm: true,
    confirmation: { target: "Revoke {target}?", consequence: "Clients using this token will lose access.", subject: { path: "/api/account/tokens", argument: "id", name: "name", collection: "tokens", identity: "id" } },
    parameters: [pathParam("id", "Your token's ID, never its secret.")],
    responses: { "200": jsonOk("#/components/schemas/TokenRevoked"), ...errors, "404": ERROR_RESPONSE } }), security: AUTH_SECURITY } },
};
const tokenProperties = { id: { type: "string" }, name: { type: "string" }, createdAt: { type: "string" }, lastUsedAt: { type: ["string", "null"] }, revokedAt: { type: ["string", "null"] },
  expiresAt: { type: ["string", "null"], description: "When the token stops working; null when it never expires. An expired token is refused with token_expired and stays listed until revoked." } };
export const ACCOUNT_SCHEMAS = {
  ApiToken: { type: "object", additionalProperties: false, properties: tokenProperties, required: Object.keys(tokenProperties) },
  CreatedApiToken: { type: "object", additionalProperties: false, properties: { ...tokenProperties, secret: { type: "string", description: "Disclosed once. Store it securely before leaving this response." } }, required: [...Object.keys(tokenProperties), "secret"] },
  ApiTokens: { type: "object", additionalProperties: false, properties: { tokens: { type: "array", items: { $ref: "#/components/schemas/ApiToken" } } }, required: ["tokens"] },
  PasswordChanged: { type: "object", additionalProperties: false, properties: { changed: { type: "boolean", const: true } }, required: ["changed"] },
  TokenRevoked: { type: "object", additionalProperties: false, properties: { revoked: { type: "boolean", const: true } }, required: ["revoked"] },
};
