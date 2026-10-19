import { NextResponse } from "next/server";
import { ERROR_CATALOGUE } from "./error-catalogue";
import { AuthError, type AuthErrorCode } from "@/lib/auth/errors";

/**
 * Every API error carries a stable machine-readable code plus a
 * human-readable message (spec: scripts and agents branch on codes, not
 * prose). Codes are catalogued in the API docs.
 */
export type ErrorCode =
  | AuthErrorCode
  | "picture_upload_retired"
  | "project_owner_cannot_leave"
  | "unsupported_format"
  | "upload_too_large"
  | "archive_too_large"
  | "remote_fetch_failed"
  /** An outbound exchange stopped because its caller stopped wanting it
   * distinct from a transport failure, so a cancelled batch never reports
   * a provider as broken. */
  | "remote_fetch_abandoned"
  | "remote_too_large"
  | "remote_timeout"
  | "egress_blocked"
  /** The satellite imagery did not answer a relayed tile with one. */
  | "imagery_unavailable"
  | "area_too_large"
  | "name_taken"
  /** A map's dependency read could not be completed: a
   * layer statement failed analysis, so the checklist would be a lie —
   * the whole read refuses instead. */
  | "dependencies_unresolved"
  | "export_failed"
  | "not_refreshable"
  | "refresh_in_flight"
  | "geometry_not_supported"
  | "geometry_choice_invalid"
  | "geometry_in_flight"
  /** A workflow has one run at a time: a start while one is in
   * flight is refused, naming it. */
  | "run_in_flight"
  /** A confirmed wide run names its members in order; the plan at start
   * differed, so nothing started. */
  | "plan_changed"
  | "connection_failed"
  | "connection_password_required"
  | "malformed_file"
  | "request_body_too_large"
  | "mcp_read_failed"
  | "mcp_transport_failed"
  | "mcp_response_invalid"
  | "method_not_allowed"
  | "stale_revision"
  | "setting_locked"
  | "invalid_request"
  | "not_found"
  | "sql_rejected"
  | "sql_error"
  | "query_timeout"
  | "engine_memory_exceeded"
  | "data_processing_timeout"
  | "request_timeout"
  | "upload_stalled"
  | "render_bytes_exceeded"
  | "query_memory_exceeded"
  | "query_result_too_large"
  | "tile_build_timeout"
  | "render_cap_exceeded"
  | "tiler_unavailable"
  | "tile_build_failed"
  | "widget_layer_missing"
  | "column_unavailable"
  | "field_not_published"
  /** A published layer or widget reading the catalogue its link withholds. */
  | "catalogue_not_published"
  | "selection_incompatible"
  | "rate_limited"
  | "catalogue_too_large"
  | "assistant_reservation_required"
  | "assistant_run_unavailable"
  | "assistant_run_conflict"
  | "assistant_capacity"
  | "assistant_run_state"
  | "assistant_submission_too_large"
  | "assistant_recovery_limit"
  | "assistant_plan_unavailable"
  | "assistant_action_uncertain"
  | "assistant_action_interrupted"
  | "assistant_action_not_admitted"
  | "assistant_choice_invalid"
  | "assistant_model_not_offered"
  | "assistant_effort_not_offered"
  | "assistant_effort_not_supported"
  | "assistant_context_invalid"
  | "assistant_context_too_large"
  | "assistant_context_unavailable"
  | "assistant_disabled"
  | "assistant_auth"
  | "assistant_provider"
  | "pending_unknown"
  | "pending_resolved"
  | "pending_superseded"
  | "render_unavailable"
  | "render_timeout"
  | "render_failed"
  /** The assistant's map check: no map named and none in context. */
  | "look_target_missing"
  /** The check's image is still over its byte bound at the smallest documented size. */
  | "look_image_too_large"
  /** The retained image of a check was evicted or did not survive a restart. */
  | "look_image_unavailable"
  | "attachment_too_large"
  | "operation_timeout"
  | "operation_queue_full"
  | "operation_interrupted"
  | "operation_superseded"
  | "measurement_crs_unavailable"
  | "input_changed"
  | "geocoder_unconfigured"
  | "geocoder_failed"
  | "isochrone_unconfigured"
  | "isochrone_failed"
  /** A service address an admin stored that the instance's encryption key
   * no longer opens: the service refuses instead of reaching a default. */
  | "service_address_unreadable"
  /** A basemap an admin hid, newly chosen for a map; the envelope names the
   * switch that hides it. */
  | "basemap_not_offered"
  /** Sketch operations. */
  | "invalid_sketch_feature"
  | "not_a_sketch"
  | "feature_not_found"
  | "vertex_move_refused"
  | "sketch_gone"
  | "map_not_found"
  /** No template with that id is shipped, downloaded or listed. */
  | "template_not_listed"
  /** The template catalogue is off: nothing is read from it. */
  | "templates_catalogue_off"
  /** A template's archive or version refused at its install: the reader's
   * coded refusals, each one class of fault. */
  | "template_archive_too_large"
  | "template_checksum_mismatch"
  | "template_unpacked_too_large"
  | "template_malformed"
  | "template_entry_escapes"
  | "template_members_mismatch"
  | "template_format_unsupported"
  | "template_invalid"
  | "template_forbidden"
  | "template_picture_too_large"
  | "template_licence_refused"
  | "template_credit_missing"
  | "template_reference_outside"
  | "template_record_mismatch"
  /** A listed version is not on this server yet: fetch it, then copy. */
  | "template_not_installed"
  /** A copy could not bind one of the template's references to the
   * datasets it lands: nothing was created. */
  | "template_reference_unbound"
  | "internal";

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    /** Documented extra fields that ride beside code and message in the
     * error envelope — e.g. A SQL error's position. Never engine
     * internals; only what the OpenAPI Error schema declares. */
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Thrown when the caller abandoned an in-flight evaluation — the
 * bounded-evaluation boundary raises it, and nobody is left to read a
 * response. Defined here so the response mapping below needs no import
 * from the query layer.
 */
export class EvaluationCancelled extends Error {
  constructor() {
    super("The caller abandoned this evaluation before it completed.");
  }
}

export class QueryResultTooLarge extends ApiError {
  constructor() {
    super("query_result_too_large", ERROR_CATALOGUE.query_result_too_large, 422);
  }
}

export function errorResponse(error: unknown): NextResponse {
  // The client already closed the request; the status is for logs only
  // (499, the de-facto client-closed-request convention).
  if (error instanceof EvaluationCancelled) {
    return new NextResponse(null, { status: 499 });
  }
  if (error instanceof ApiError || error instanceof AuthError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, ...error.extra } },
      { status: error.status },
    );
  }
  // An unexpected failure crosses no internals: a raw message carries
  // filesystem paths, the key-file location, and engine text. The wire
  // gets the documented internal sentence; the detail stays in the
  // server log, where the administrator reads it.
  console.error("[api] unexpected error:", error);
  return NextResponse.json(
    { error: { code: "internal", message: ERROR_CATALOGUE.internal } },
    { status: 500 },
  );
}
