import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { PICTURE_VERSION_PROPERTY } from "./openapi-picture-version";
import { READ_ONLY, resource, writes } from "./operation-metadata";

export const AUTH_SECURITY = [{ CookieSession: [] }, { BearerToken: [] }];
const accountPrecondition = " Optional X-Dezfil-Account asserts the credential's expected account ID. A mismatch returns 401 authentication_required before dispatch. This transport precondition never supplies identity or changes ownership.";
export const AUTH_SECURITY_SCHEMES = {
  CookieSession: { type: "apiKey", in: "cookie", name: "dezfil_session", description: "HttpOnly, SameSite=Lax session. Secure over HTTPS. On a listening port other than 3000 the name carries the port suffix, and DEZFIL_SESSION_COOKIE sets the name. Lasts the instance's session length, security.sessionDays, thirty days by default; each use renews it by the length stored then." + accountPrecondition },
  BearerToken: { type: "http", scheme: "bearer", description: "An account's API token. Its current account status and privileges are checked on every request; once a token's expiry passes it is refused with token_expired." + accountPrecondition },
};
const body = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  "x-byte-limit": 65_536, required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties, required } } },
});
const password = { type: "string", minLength: 8, writeOnly: true, description: "At least eight characters; very common passwords are refused. No character classes are required." };
const email = { type: "string", description: "Local email identity, normalized for case and surrounding whitespace." };
export const AUTHENTICATION_BUSY_RESPONSE = { ...ERROR_RESPONSE, description: "ingress_unavailable when provenance is missing, or authentication_busy: Authentication is busy. Try again shortly. Capacity refusal has error.retryAfter: 1, Retry-After: 1 and private, no-store; no credentials, link consumption, profile or password changes, or login failures result.", headers: { "Retry-After": { description: "One second for authentication_busy.", schema: { type: "integer", const: 1 } } } };
export const DERIVATION_ADMISSION = " Password derivations share two active slots and at most eight waiters: six ordinary and two reserved protected, each waiting at most five seconds. FIFO within each class; validated links and signed-in current-password work are protected, including the second password-change derivation. Protected work takes the next free slot but at most one active slot, even with ordinary slots idle. Ordinary work may use both; running work is never pre-empted. A fourth simultaneous protected caller is refused at once and may retry immediately without a login lockout; the busy response advises a one-second retry. Known and unknown sign-ins are ordinary. Overflow or deadline answers authentication_busy. Cancellation removes waiters; native work owns its slot until it settles. Recovery issuance derives nothing.";
const success = { "413": ERROR_RESPONSE, "200": jsonOk("#/components/schemas/AccountSession"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "409": ERROR_RESPONSE, "503": AUTHENTICATION_BUSY_RESPONSE };
const entry = "Cookie mutations and entry submissions require an Origin matching the trusted request origin. Explicit bearer authentication does not use cookies. Responses are private, no-store. ";
/** The Origin an entry submission must carry: without it, or with another,
 * the submission is refused with forbidden before anything is read. */
const ORIGIN_PARAMETER = { name: "Origin", in: "header", required: true, schema: { type: "string" },
  description: "The address the instance is opened at, its scheme, host and port, such as http://localhost:3000. Missing or another origin: 403 forbidden." };
const mutation = (summary: string, description: string, properties: Record<string, unknown>) => ({ ...op({ summary, description: entry + description + DERIVATION_ADMISSION, tag: "Accounts", tool: false,
  effects: writes(resource("accounts")), parameters: [ORIGIN_PARAMETER], requestBody: body(properties), responses: success }), security: [] });
export const AUTH_PATHS = {
  "/api/auth/entry": { get: { ...op({ summary: "Authentication entry information", tag: "Accounts", tool: false, effects: READ_ONLY,
    description: "The instance name, sign-in message, lost-password contact, landing page, the shortest password a password chosen on these screens needs, and setup availability. The landing page value does not change navigation. Before setup, the legacy display name may prefill Name. Never returns a signed-in person's identity or account preferences. Private, no-store.",
    responses: { "200": jsonOk("#/components/schemas/AuthEntry"), "503": ERROR_RESPONSE } }), security: [] } },
  "/api/auth/setup": { post: mutation("Create the first account", "Atomically creates the sole initial admin, adopts legacy preferences and establishes a cookie session. Once any account exists, setup_complete refuses further creation.", { name: { type: "string" }, email, password }) },
  "/api/auth/sign-in": { post: { ...mutation("Sign in", "Unknown email and wrong password share invalid_credentials. Valid credentials for a deactivated account return account_deactivated. Account failure limits apply only to sources with recent failures; a correct password from a source without recent failures can sign in even when the account budget is exhausted. Failures from every source count against the account, and source limits always apply. Cancellation after derivation starts retains the source reservation against its per-address budget (the instance setting, twenty attempts by default) until the fifteen-minute window expires, refunds the account reservation and adds no failures, preserving the clean-source exception. Limits return rate_limited with Retry-After, retryAfter seconds and retryAt (ISO timestamp); waiting restores admission.", { email, password: { type: "string", writeOnly: true } }),
    responses: { ...success, "429": { ...ERROR_RESPONSE, headers: { "Retry-After": { description: "Seconds until another attempt is permitted.", schema: { type: "integer", minimum: 1 } } } } } } },
  "/api/auth/redeem": { post: mutation("Redeem a sign-in link", "An ordinary admin-issued link expires after the instance's link lifetime it was issued with, security.linkDays, seven days by default; local filesystem recovery issues a fifteen-minute link. Both are consumed once. Invalid, expired, replaced and reused links return invalid_link without changing the password or session. Success replaces the browser's cookie with the recipient's session, even when another account was signed in.", { secret: { type: "string", writeOnly: true }, password }) },
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
      pictureVersion: PICTURE_VERSION_PROPERTY,
      status: { type: "string", enum: ["invited", "active", "deactivated"] }, isOriginal: { type: "boolean" },
      createdAt: { type: "string" }, updatedAt: { type: "string" }, lastSignInAt: { type: ["string", "null"] } },
    required: ["id", "name", "email", "sqlName", "isAdmin", "status", "isOriginal", "createdAt", "updatedAt", "lastSignInAt"] },
  AccountSession: { type: "object", properties: { account: { $ref: "#/components/schemas/Account" } }, required: ["account"], additionalProperties: false },
  AuthEntry: { type: "object", properties: { instanceName: { type: ["string", "null"] }, signInMessage: { type: "string", maxLength: 280, default: "" }, lostPasswordContact: { type: "string", maxLength: 120, default: "" }, landingPage: { type: "string", enum: ["home", "projects", "maps", "workflows", "data", "sql"], default: "home" },
    passwordMin: { type: "integer", minimum: 8, maximum: 64, description: "The fewest characters a password chosen on these screens needs: 8 for the first account, then the instance's shortest password, which admins set from 8 to 64." },
    setupRequired: { type: "boolean" }, prefillName: { type: "string" } }, required: ["instanceName", "signInMessage", "lostPasswordContact", "landingPage", "passwordMin", "setupRequired"], additionalProperties: false },
  SignedOut: { type: "object", properties: { signedOut: { type: "boolean", const: true } }, required: ["signedOut"], additionalProperties: false },
};
