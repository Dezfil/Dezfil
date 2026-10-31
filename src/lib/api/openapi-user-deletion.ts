import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op, pathParam } from "./openapi-helpers";
import { LOCAL_DELETE, LOCAL_READ } from "./operation-mcp";
import { READ_ONLY, resource, writes } from "./operation-metadata";

const privacy = "Requires a current admin account through a cookie session or bearer token. Cookie mutations require the same trusted Origin. Responses, including refusals, are private, no-store. ";
const errors = { "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE, "409": ERROR_RESPONSE, "503": ERROR_RESPONSE };
const hostLimits = "Deletion is permanent erasure of the account and everything it owns, wherever filed; shared reach and published links end. Owned projects dissolve and surviving members' work becomes unfiled. No handover occurs. Deactivation keeps shared reads, copies, runs and links. Except for never-redeemed invitations, deletion purges all geocode, isochrone and Overpass answer caches; later requests contact providers again. The identifying SQL name stays reserved forever for an ever-active account; completion frees its email. Others' derived datasets and stored SQL, lineage and run text remain theirs and can retain names or personal text. Issued private copies keep their shipped lifetime; completion waits for prepared files to settle or expire and cleanup to finish. Recorded input evidence identifies affected foreign card images, tiles, renders and prepared files; existing unattributed card images owned by others remain. Deleting a workflow removes its run records while its output datasets remain. Host snapshots, backups, logs, providers, browser-local SQL/conversations, exports, downloaded files and databases written through connections are outside erasure; restoring a backup can revive data and credentials. This is neither disk-remanence erasure nor anonymization. Pending or needs-retry is unfinished, never completed success: use status or Finish deleting with the same identifier; the account and its work stay inaccessible. Finishing rewrites the whole metadata store and pauses every response. An outside database reader or insufficient free working space on the data volume or SQLite temporary filesystem can prevent compaction; release the reader or restore space, then Finish deleting safely with the same identifier. ";
const consequence = "This permanently erases the account and everything it owns. Other people lose shared access and published links stop working. This cannot be undone.";
const effects = writes(...(["accounts", "maps", "layers", "tables", "publications", "recipes", "runs", "projects", "connections", "assistant"] as const).map(kind => resource(kind)));
const result = { "200": jsonOk("#/components/schemas/AccountDeletionStatus", "Deletion completed."),
  "202": jsonOk("#/components/schemas/AccountDeletionStatus", "Deletion is pending or needs retry; erasure is unfinished."), ...errors };
export const DELETE_USER_OPERATION = { ...op({ summary: "Delete a user", description: privacy + hostLimits +
  "First deactivate an ever-active target separately and call preview_user_deletion. Submit confirm: true, the opaque confirmation and the exact current email for an ever-active account. A never-redeemed invitation requires explicit confirmation but no email; it is removed wholly and frees its SQL name. No private content read is granted. Missing confirmation returns invalid_request; self_change_refused takes precedence over account_not_deactivated. Acceptance rechecks eligibility and the owned inventory in the same transaction; a stale eligible preview returns deletion_changed without effects. A repeated acceptance returns the same unfinished identifier and state without restarting cleanup. After completion, this target and the completed deletion identifier return not_found.",
  tag: "Accounts", storage: "recovery", tool: "delete_user", effects, mcp: LOCAL_DELETE, confirm: true,
  display: { verb: "Requested account deletion" },
  confirmation: { target: "Delete this account and its work?", consequence,
    subject: { path: "/api/users", argument: "id", name: "name", collection: "users", identity: "id" } },
  parameters: [pathParam("id", "The other account to delete.")],
  requestBody: { "x-byte-limit": 65_536, required: true, content: { "application/json": { schema: {
    type: "object", additionalProperties: false, properties: { confirm: { type: "boolean", const: true },
      confirmation: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Opaque value from this admin's current deletion preview." },
      email: { type: "string", description: "Exact account email, required when the account has ever signed in." } }, required: ["confirm", "confirmation"],
  } } } }, responses: result }), security: AUTH_SECURITY };

export const USER_DELETION_PATHS = {
  "/api/users/{id}/deletion-preview": { get: { ...op({ summary: "Preview user deletion", description: privacy +
    "Returns only the account identity already visible in Users, totals per owned kind and distinct other active people whose present reach shrinks. Never returns private names, project references, rosters or content. The opaque confirmation is bound to the target, requesting admin, eligibility generation, inventory identities, publication links, grants and filings. Same-count swaps, publication changes and a reactivate/deactivate cycle invalidate it; unrelated surviving-document edits do not. A pending deletion returns its identifier and unfinished state instead. Self and active-target refusals are identical to deletion. This read erases nothing.",
    tag: "Accounts", tool: "preview_user_deletion", effects: READ_ONLY, mcp: LOCAL_READ, display: { verb: "Read a deletion preview" },
    parameters: [pathParam("id", "The other account to preview.")], responses: { "200": jsonOk("#/components/schemas/AccountDeletionPreviewResult"), ...errors } }), security: AUTH_SECURITY } },
  "/api/users/deletions/{id}": { get: { ...op({ summary: "Read user deletion status", description: privacy +
    "Returns pending or needs-retry for unfinished deletion. A pending deletion also carries admittedReads, the reads admitted before it that it still waits on: erasure starts once they settle, and a count that stays above zero means a reader has not let go. An unreadable deletion record returns 409 deletion_unreadable and remains untouched. No stage, failure detail or content is exposed. Completed identifiers return 404 not_found because their temporary records have been removed; after an accepted response, clients may refresh list_users to reconcile a missing identifier. A missing identifier without prior acceptance is not proof that an account was deleted.",
    tag: "Accounts", tool: "get_user_deletion", effects: READ_ONLY, mcp: LOCAL_READ, display: { verb: "Read account deletion status" },
    parameters: [pathParam("id", "The accepted deletion identifier, not an account id.")], responses: { "200": jsonOk("#/components/schemas/AccountDeletionProgress"), ...errors } }), security: AUTH_SECURITY } },
  "/api/users/deletions/{id}/finish": { post: { ...op({ summary: "Finish deleting a user", description: privacy + hostLimits +
    "Resumes the accepted deletion, including after restart, without changing its identifier or repeating completed dissolution. Concurrent requests join the same work. An unreadable record returns 409 deletion_unreadable without changing any files. Completed identifiers return 404 not_found.",
    tag: "Accounts", storage: "recovery", tool: "finish_user_deletion", effects, mcp: LOCAL_DELETE, confirm: true, display: { verb: "Continued account deletion" },
    confirmation: { target: "Finish deleting this account?", consequence, subject: { path: "/api/users", argument: "id", name: "account.name", collection: "deletions", identity: "id" } },
    parameters: [pathParam("id", "The accepted deletion identifier, not an account id.")], responses: result }), security: AUTH_SECURITY } },
};
const identity = { type: "object", additionalProperties: false, properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } }, required: ["id", "name", "email"] };
export const USER_DELETION_SCHEMAS = {
  AccountDeletionStatus: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, state: { type: "string", enum: ["pending", "needs-retry", "completed"] } }, required: ["id", "state"] },
  AccountDeletionProgress: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, state: { type: "string", enum: ["pending", "needs-retry"] },
    admittedReads: { type: "integer", minimum: 0, description: "Present while pending: the reads admitted before the deletion that it still waits on to settle." } }, required: ["id", "state"] },
  PendingAccountDeletion: { oneOf: [{ type: "object", additionalProperties: false, properties: { id: { type: "string" }, state: { type: "string", enum: ["pending", "needs-retry"] },
    account: { ...identity, properties: { ...identity.properties, isAdmin: { type: "boolean" } }, required: [...identity.required, "isAdmin"] } }, required: ["id", "state", "account"] },
    { type: "object", additionalProperties: false, properties: { id: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }, state: { type: "string", const: "unreadable" } }, required: ["id", "state"] },
  ] },
  AccountDeletionPreview: { type: "object", additionalProperties: false, properties: { account: identity, invited: { type: "boolean" },
    totals: { type: "object", additionalProperties: false, properties: Object.fromEntries(["maps", "datasets", "workflows", "projects", "connections", "publishedLinks"].map(key => [key, { type: "integer", minimum: 0 }])), required: ["maps", "datasets", "workflows", "projects", "connections", "publishedLinks"] },
    people: { type: "integer", minimum: 0 }, confirmation: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["account", "invited", "totals", "people", "confirmation"] },
  AccountDeletionPreviewResult: { anyOf: [{ $ref: "#/components/schemas/AccountDeletionPreview" }, { $ref: "#/components/schemas/AccountDeletionStatus" }] },
};
