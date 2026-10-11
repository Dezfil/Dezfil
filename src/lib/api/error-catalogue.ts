import type { ErrorCode } from "./errors";

/** Human-readable meaning for every machine-readable error code (spec: every
 * error's code appears in the API documentation). Single source, rendered
 * into the docs and the OpenAPI description. */
export const ERROR_CATALOGUE: Record<ErrorCode, string> = {
  setting_locked: "An environment variable locks a submitted setting. No settings changed; change or remove the named variable and restart before editing this setting.",
  project_owner_cannot_leave: "The project's owner cannot leave. Transfer or delete the project instead.",
  method_not_allowed: "This method is not allowed for this path.",
  authentication_required: "Sign in with a valid session or account token to continue.",
  invalid_credentials: "Email or password is incorrect.",
  account_deactivated: "This account is deactivated. Contact an admin.",
  setup_complete: "This instance already has an account. First-account creation is unavailable.",
  weak_password: "Use at least eight characters and avoid very common passwords.",
  email_taken: "An account already uses this normalized email address.",
  self_change_refused: "Another admin must change your admin flag, deactivate your account or delete it.",
  account_not_deactivated: "Deactivate this account before deleting it.",
  deletion_in_progress: "This account is being deleted and cannot be reactivated.",
  deletion_changed: "This account or its work has changed. Review a fresh deletion preview before confirming.",
  last_admin: "Keep at least one active admin.",
  forbidden: "This request is not permitted for the current account or origin: an admin-only request, a cookie request from another origin, or a change to something the account can view but cannot make. A refused change has no effect.",
  invalid_link: "This sign-in link is unavailable, expired, replaced or already used.",
  token_expired: "The API token has passed the expiry it was created with and no longer works. Create a new token; the expired one stays listed until it is revoked.",
  rule_refused: "An instance rule an admin sets refuses this action for the current account: creating an API token, publishing a map or changing a live publication, adding a database connection or pointing one at another host, port or database, or importing from a link. The refusal's rule field names the rule as PATCH /api/instance/settings takes it. Nothing changed, and what already exists keeps working.",
  current_password_required: "Enter your current password to make this change.",
  authentication_busy: "Authentication is busy. Try again shortly.",
  ingress_unavailable: "Trusted socket provenance is unavailable. Authentication entry and published reads cannot proceed.",
  geometry_not_supported: "Set geometry is available only for file uploads and URL imports.",
  geometry_choice_invalid: "The geometry choice cannot be applied. The message explains the projection, source or validator issue.",
  geometry_in_flight: "A geometry edit or refresh is already running for this dataset or URL import group.",
  unsupported_format:
    "The uploaded file type is not one of the supported formats.",
  upload_too_large: "The upload exceeds the configured size cap.",
  archive_too_large:
    "The archive's unpacked content exceeds the configured upload size cap.",
  remote_fetch_failed:
    "The remote file could not be fetched (unreachable, denied, or missing).",
  remote_fetch_abandoned:
    "The outbound request was abandoned before it finished, because whoever asked for it stopped waiting.",
  remote_too_large: "The remote file exceeds the configured remote size cap.",
  remote_timeout:
    "The remote fetch exceeded the configured remote time bound.",
  egress_blocked:
    "The destination address is blocked by the egress policy (loopback, private, link-local, or metadata space); the configured allowlist admits exceptions.",
  area_too_large:
    "The selected area exceeds the import budget for the chosen theme.",
  name_taken:
    "A table of that name already exists. Operations never replace or rename " +
    "around an existing table. Choose another name.",
  not_refreshable:
    "The table has no re-runnable remote source, so it cannot be refreshed.",
  dependencies_unresolved:
    "A layer's statement could not be analyzed, so the map's datasets " +
    "cannot be listed completely. Fix the layer's SQL and try again.",
  export_failed:
    "The project archive could not be assembled; nothing was delivered. " +
    "Retry, and check the server's disk space if it recurs.",
  refresh_in_flight:
    "A refresh of this table (or its OSM import group) is already running; retry when it completes.",
  connection_failed:
    "The database connection failed (unreachable, authentication, or missing extension).",
  connection_password_required:
    "Enter the password again when changing the host or port, or turning SSL off.",
  malformed_file: "The file could not be parsed as its declared format.",
  request_body_too_large:
    "The request body exceeds its documented byte limit.",
  mcp_read_failed: "The read could not be completed because its response could not be received.",
  mcp_transport_failed: "The operation's response could not be received. Its outcome is unknown.",
  mcp_response_invalid: "The instance returned a response that does not match this operation's documented result.",
  stale_revision: "This item has changed. Reload it before trying again.",
  invalid_request: "The request was malformed or failed validation, including a missing or malformed required edit revision. Read the item before a covered write.",
  not_found: "The requested resource was not found.",
  sql_rejected: "The SQL was not an accepted read-only query.",
  sql_error: "The SQL failed to parse or execute.",
  query_timeout: "The query exceeded the configured timeout.",
  query_memory_exceeded:
    "The query exceeded the configured engine memory budget for user SQL.",
  query_result_too_large:
    "The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.",
  tile_build_timeout:
    "A tile-build stage exceeded the configured tile-build timeout.",
  render_cap_exceeded:
    "The layer's result exceeds the inline render cap; tiled rendering is unavailable for this geometry or configuration.",
  tiler_unavailable:
    "The result is too large for inline rendering and no tile builder is installed on this instance.",
  tile_build_failed: "The layer's tile archive could not be built.",
  render_unavailable:
    "The image renderer's browser is not available on this instance, so image export cannot run.",
  render_timeout:
    "The image render exceeded the configured export render budget (queue wait included).",
  render_failed:
    "The image could not be rendered. Retry; if it persists, the instance's renderer needs attention.",
  look_target_missing:
    "No map was named for the check and none is in context, so there is nothing to render.",
  look_image_too_large:
    "No image of the map fits inside the check's byte bound at any documented size, so none was returned.",
  look_image_unavailable:
    "The image of this check is no longer kept on this instance: it was evicted under the retention bounds or did not survive a restart. It is never rendered again.",
  attachment_too_large:
    "The tool attachment exceeds the configured cap; narrow the export or raise the cap.",
  operation_timeout:
    "The operation exceeded the configured execution budget for a run. Time spent waiting for the lane is not counted against it.",
  operation_queue_full:
    "Too many operations are already queued; the run was refused rather than accepted into a queue that would not drain. Retry once some complete.",
  run_in_flight:
    "This workflow already has a run in flight; a workflow runs one at a time. Wait for it, or cancel it, then run again.",
  plan_changed:
    "The workflow changed since the run was confirmed, so the nodes it would run are not the ones confirmed. Nothing started; look at the plan again.",
  operation_interrupted:
    "The server stopped while this run was in the lane, so it did not finish. Nothing partial was kept; run it again.",
  input_changed:
    "An input was replaced while the run was waiting, so the answers it had prepared belong to data that is no longer there. Nothing was written; run it again against the current data.",
  geocoder_unconfigured:
    "No geocoding endpoint is configured on this instance (the Address finder an admin sets, or DEZFIL_GEOCODER_URL), so an operation that asks a provider for addresses cannot run. The message says which one to change now.",
  geocoder_failed:
    "The configured geocoding endpoint did not answer, twice in a row. The run published nothing rather than recording an absent answer as an address that does not exist.",
  isochrone_unconfigured:
    "No routing endpoint is configured on this instance (the travel-time endpoint an admin sets, or DEZFIL_ISOCHRONE_URL), so an operation that asks a provider for travel-time areas cannot run. The message says which one to change now.",
  isochrone_failed:
    "The configured routing endpoint did not answer, twice in a row. The run published nothing rather than recording an absent answer as an unreachable origin.",
  service_address_unreadable:
    "A service address, or the satellite imagery's tile template, an admin saved in Settings cannot be read with this instance's encryption key, which changed after it was saved. The service, or the imagery style, refuses rather than reach a default; an admin saves the address again.",
  basemap_not_offered:
    "The basemap a map write or an undo or redo would put a map on is one this instance does not offer now: a style an admin hid, or, while style addresses on single maps are off, a style address the basemap library does not offer. It cannot be chosen anew. The refusal's setting field names the switch, as PATCH /api/instance/settings takes it. Nothing changed; a map already on that basemap keeps it, and Auto is always offered.",
  measurement_crs_unavailable:
    "The data spans more of the earth than any local projection covers, so a distance measured over it would not be in ground metres. Split it by region and measure each part; an area over the same data succeeds and records the global projection it used.",
  operation_superseded:
    "The step this run belonged to was changed or removed while it was working, so the run lost its authority to publish and wrote nothing. What it would have produced is no longer what the step means.",
  widget_layer_missing:
    "The widget references a layer that no longer exists, so its value cannot be computed.",
  column_unavailable:
    "The write introduces a reference to a column the layer's result does not provide, or provides with a type the channel cannot use, so it was refused; stored references are never retro-refused.",
  field_not_published:
    "The selection references a field the published surface does not declare: outside the layer's effective published field set and not a published widget's field.",
  catalogue_not_published:
    "A published layer or widget whose SQL reads the instance's catalogue does not evaluate on the link while its owner holds datasets the map does not name: a published map reaches only the datasets its own layers name, and the link would otherwise disclose the others.",
  selection_incompatible:
    "The selection's values cannot be evaluated against its field's type (for example a time range on a non-time field); it was refused before evaluation.",
  rate_limited: "Too many requests or sign-in attempts; retry after the indicated delay.",
  catalogue_too_large: "The schema page exceeds 96 KiB. Request fewer tables or columns.",
  assistant_reservation_required: "Reserve a run with POST /api/assistant/runs, then send its id as runId.",
  assistant_run_unavailable: "This run identity is unavailable and cannot execute.",
  assistant_run_conflict: "This run identity is already bound to different input.",
  assistant_capacity: "Eight assistant runs occupy capacity. Read GET /api/assistant/pending; release an unused reservation or abandon a pending turn with DELETE /api/assistant/runs/{id}.",
  assistant_run_state: "This operation is not available in the current run state.",
  assistant_submission_too_large: "The assistant submission exceeds 128 KiB.",
  assistant_recovery_limit: "Further work stopped before the live recovery bound could be exceeded.",
  assistant_plan_unavailable: "The current workflow membership could not be established. No run was approved or started.",
  assistant_action_uncertain: "The action outcome could not be established. Its declared resources may have changed.",
  assistant_action_interrupted: "The read was interrupted before completion.",
  assistant_action_not_admitted: "The run's page context does not admit this operation; nothing was performed. Runs under a /sql or workflow context admit only operations that declare themselves read-only, and none that reaches outside this server or asks for confirmation.",
  assistant_choice_invalid: "The submitted model choice is malformed: it must be an object whose optional model and effort are strings.",
  assistant_model_not_offered: "The requested model is not one this instance offers. GET /api/assistant lists the models it offers.",
  assistant_effort_not_offered: "The requested effort is not one the selected model offers. GET /api/assistant lists each model's own efforts.",
  assistant_effort_not_supported: "The selected model has no effort levels of its own, so it takes only the provider default. Send the effort \"default\", or no effort at all, or choose a model that offers levels. GET /api/assistant lists each model's own efforts.",
  assistant_context_invalid: "The submitted page context is malformed or refers to an incompatible object.",
  assistant_context_too_large: "Page context exceeds 64 KiB of UTF-8 JSON.",
  assistant_context_unavailable: "The page context could not be read from this instance.",
  assistant_disabled:
    "The assistant is not enabled; no model credential is configured.",
  assistant_auth:
    "The configured model credential was rejected by the provider.",
  assistant_provider:
    "The model provider request failed (outage, quota, or network).",
  pending_unknown:
    "The referenced pending action is unknown; it may have expired with the server's working state.",
  pending_resolved:
    "The referenced pending action was already resolved; it will not run again.",
  pending_superseded:
    "A newer message superseded the referenced pending action, declining it.",
  invalid_sketch_feature:
    "The submitted sketch feature failed the structural gate: kind, geometry family, coordinate ranges, ring closure or the published vertex ceiling.",
  not_a_sketch:
    "The named table is not a sketch dataset; sketch operations apply only to tables drawn on a map.",
  feature_not_found:
    "No drawn feature with the given id exists in the sketch dataset.",
  vertex_move_refused:
    "The vertex move was refused: only drawn polygons and freehand shapes offer vertex handles, and the index must name an existing vertex.",
  sketch_gone:
    "The sketch dataset was deleted or replaced while the change was in flight; nothing was written.",
  map_not_found: "No map exists with the given id.",
  template_not_listed:
    "No template with that id is shipped with this instance, downloaded to it or listed by the catalogue list it last read.",
  templates_catalogue_off:
    "An admin turned the template catalogue off (the templates.catalogue setting), so the server reaches it for nothing: no refresh, Test or download is sent. Shipped and downloaded templates still open and copy.",
  template_archive_too_large:
    "A template's archive is larger than the size the catalogue's index declares for it, or than the 150 MB a template archive may be; nothing was installed.",
  template_checksum_mismatch:
    "A template's archive arrived with another size or another SHA-256 than the catalogue's index declares; nothing was installed.",
  template_unpacked_too_large:
    "A template's archive unpacks past this instance's upload cap; nothing was installed.",
  template_malformed:
    "A template's archive is not one this server reads: not a readable ZIP holding one .dezfil folder, a document that is not JSON, or a dataset the upload's reader cannot read.",
  template_entry_escapes:
    "A member of a template's archive names a path outside its folder.",
  template_members_mismatch:
    "A template's documents name a member it does not hold, or it holds a member nothing names.",
  template_format_unsupported:
    "A template is in a format version this server does not read.",
  template_invalid:
    "A template's document fails the rules a client's document is held to, or one of its layers or steps does not bind to the template's own data as a client's would.",
  template_forbidden:
    "A template carries a publication, token, connection, service address or setting, which no template may.",
  template_picture_too_large:
    "A template's map picture is larger than its 2 MB bound.",
  template_licence_refused:
    "A template's data is under a licence that does not allow redistribution.",
  template_credit_missing:
    "A template's credit note does not name every source with its licence.",
  template_reference_outside:
    "A template's layer or step names a dataset that is neither the template's own nor the result of an earlier step, such as a person's dataset or another template's.",
  template_record_mismatch:
    "An installed template's files differ from the record written when it was installed, so it is refused rather than trusted.",
  internal: "An unexpected server error occurred.",
};

/** The message the published wire carries for a coded failure: exactly the
 * documented sentence for the code, never text from the engine, the tile
 * builder, or the runtime. An unknown code falls back to the internal
 * sentence rather than leaking anything. */
export function publishedMessage(code: string): string {
  return code in ERROR_CATALOGUE
    ? ERROR_CATALOGUE[code as ErrorCode]
    : ERROR_CATALOGUE.internal;
}
