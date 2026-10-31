import { AUTH_SECURITY, EXTERNAL_PASSWORD_REFUSAL } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op, pathParam } from "./openapi-helpers";
import { LOCAL_ADD, LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { READ_ONLY, resource, writes } from "./operation-metadata";
import { DELETE_USER_OPERATION, USER_DELETION_PATHS, USER_DELETION_SCHEMAS } from "./openapi-user-deletion";
const privacy = "Requires a current admin account through a cookie session or bearer token. Cookie mutations require the same trusted Origin. Responses, including refusals, are private, no-store. ";
const errors = { "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "409": ERROR_RESPONSE, "503": ERROR_RESPONSE };
const body = (properties: Record<string, unknown>, required: string[], extra = {}) => ({ "x-byte-limit": 65_536, required: true,
  content: { "application/json": { schema: { type: "object", additionalProperties: false, properties, required, ...extra } } } });
const subject = { path: "/api/users", argument: "id", name: "name", collection: "users", identity: "id" };
export const USERS_PATHS = {
  ...USER_DELETION_PATHS,
  "/api/users": {
    get: { ...op({ summary: "List users", description: privacy + "Lists invited, active and deactivated accounts, their role and last sign-in. isOriginal permanently identifies the first account. The separate deletions array lists unfinished reservations with their deletion id, pending or needs-retry state and the existing Users identity; it remains available after profile erasure and disappears on completion. An unreadable deletion appears separately as {id, state: unreadable}, without an account identity. It does not block other users, invitations or access changes; its status and continuation return deletion_unreadable. Deleted accounts are absent from users. Passwords, credential hashes and sign-in links are never returned.",
      tag: "Accounts", tool: "list_users", effects: READ_ONLY, mcp: LOCAL_READ, display: { verb: "Read the users" },
      responses: { "200": jsonOk("#/components/schemas/Users"), ...errors } }), security: AUTH_SECURITY },
    post: { ...op({ summary: "Invite a user", description: privacy + "Reserves a name and normalized email. In external sign-in mode it returns only account and creates no link, session or token; the recipient signs in through the sign-in service. Otherwise it returns a signInUrl once. The recipient chooses a password when opening the link; this instance sends no email. The link expires after the instance's link lifetime, security.linkDays, seven days by default, and keeps the lifetime it was issued with. isAdmin defaults to false and an admin may explicitly grant it. Duplicate emails return email_taken regardless of case or surrounding whitespace, including invited and deactivated accounts. An email awaiting deletion completion remains reserved, including after its profile is removed, and never offers reactivation. For a deactivated duplicate the error carries accountId and canReactivate: true; reactivate that account instead of creating another.",
      tag: "Accounts", tool: "invite_user", effects: writes(resource("accounts", undefined, "account.id")), mcp: LOCAL_ADD,
      display: { verb: "Invited {subject}", subject: { resource: "accounts", result: "account.id", name: ["account.name", "name"] } }, confirm: true,
      confirmation: { target: "Invite this person to the instance?", consequence: "They can sign in with the permissions you grant through the configured sign-in method.", subject: { path: "/api/account", argument: "", name: "account.name" } },
      requestBody: body({ name: { type: "string", minLength: 1 }, email: { type: "string" }, isAdmin: { type: "boolean", default: false } }, ["name", "email"]),
      responses: { "201": jsonOk("#/components/schemas/UserInvitation"), ...errors, "409": jsonOk("#/components/schemas/UserInvitationConflict", "Email already reserved.") } }), security: AUTH_SECURITY },
  },
  "/api/users/{id}": { delete: DELETE_USER_OPERATION, patch: { ...op({ summary: "Change user access", description: privacy + "Grants or removes admin status, deactivates or reactivates the same account. Self-deactivation and self-removal of admin status return self_change_refused even with another admin. Competing changes cannot remove every active admin. A patch is applied atomically or not at all. Deactivation ends sessions and refuses tokens; reactivation restores token eligibility without reviving ended sessions. Reactivating an unaccepted invitation returns it to invited status. This operation does not delete accounts or content. Accepted deletion refuses reactivation with deletion_in_progress, including during final cleanup after the profile is removed.",
    tag: "Accounts", tool: "update_user_access", effects: writes(resource("accounts", "id")), mcp: LOCAL_REPLACE,
    display: { verb: "Changed access for {subject}", subject: { resource: "accounts", argument: "id" } }, confirm: true,
    confirmation: { target: "Change access for {target}?", consequence: "Role changes apply immediately. Deactivation ends browser sessions and refuses API tokens.", subject },
    parameters: [pathParam("id", "The account to change.")],
    requestBody: body({ isAdmin: { type: "boolean" }, status: { type: "string", enum: ["active", "deactivated"] } }, [], { anyOf: [{ required: ["isAdmin"] }, { required: ["status"] }] }),
    responses: { "200": jsonOk("#/components/schemas/AccountSession"), ...errors, "404": ERROR_RESPONSE } }), security: AUTH_SECURITY } },
  "/api/users/{id}/sign-in-link": { post: { ...op({ summary: "Issue a new sign-in link", description: EXTERNAL_PASSWORD_REFUSAL + privacy + "Returns a one-time signInUrl expiring after the instance's link lifetime, security.linkDays, seven days by default; the link keeps the lifetime it was issued with. Replaces every earlier unused link, invalidates the current password and ends browser sessions while API tokens stay valid. The recipient chooses their password and enters as this account even if another account was signed in. An expired, replaced or consumed link grants no access. This instance sends no email; share the returned link with its recipient.",
    tag: "Accounts", tool: "issue_user_sign_in_link", effects: writes(resource("accounts", "id")), mcp: LOCAL_REPLACE,
    display: { verb: "Issued a sign-in link for {subject}", subject: { resource: "accounts", argument: "id" } }, confirm: true,
    confirmation: { target: "Issue a new sign-in link for {target}?", consequence: "The current password and earlier links will stop working. Browser sessions will end; API tokens stay valid.", subject },
    parameters: [pathParam("id", "The account receiving the sign-in link.")],
    responses: { "200": jsonOk("#/components/schemas/IssuedSignInLink"), ...errors, "404": ERROR_RESPONSE } }), security: AUTH_SECURITY } },
};
export const USERS_SCHEMAS = {
  ...USER_DELETION_SCHEMAS,
  UserInvitationConflict: { type: "object", additionalProperties: false, properties: { error: { type: "object", additionalProperties: false,
    properties: { code: { type: "string", const: "email_taken" }, message: { type: "string" }, accountId: { type: "string" }, canReactivate: { type: "boolean" } }, required: ["code", "message"] } }, required: ["error"] },
  Users: { type: "object", additionalProperties: false, properties: { users: { type: "array", items: { $ref: "#/components/schemas/Account" } }, deletions: { type: "array", items: { $ref: "#/components/schemas/PendingAccountDeletion" } } }, required: ["users", "deletions"] },
  UserInvitation: { type: "object", additionalProperties: false, properties: { account: { $ref: "#/components/schemas/Account" }, signInUrl: { type: "string", description: "Present only in password mode. One-time link with its credential in the fragment." }, expiresAt: { type: "string", format: "date-time", description: "Present only with signInUrl." } }, required: ["account"], dependentRequired: { signInUrl: ["expiresAt"], expiresAt: ["signInUrl"] } },
  IssuedSignInLink: { type: "object", additionalProperties: false, properties: { account: { $ref: "#/components/schemas/Account" }, signInUrl: { type: "string", description: "One-time hand-over. The credential is in the fragment, never the query string." }, expiresAt: { type: "string", format: "date-time" } }, required: ["account", "signInUrl", "expiresAt"] },
};
