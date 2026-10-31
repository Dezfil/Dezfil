import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ASSISTANT_ACCOUNT_CAPACITY, ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { AssistantRecord } from "./AssistantRecord";
import { PaneFailureNote } from "./PaneFailureNote";
import { failureWords } from "./assistant-words";

/**
 * The pane's words for a failure. Each of the four failure paths is
 * rendered through its boundary with transport text in it: the HTTP
 * path with the catalogue's own capacity sentence, which names a method
 * and two paths; the stream path with the reservation sentence, which
 * names a POST; an action result and a recovery error with seeded
 * transport text. What a person reads carries no method, no path and no
 * status code offered as an instruction; a SQL error's own numbers and
 * identifiers survive.
 */

const TRANSPORT = /\b(GET|POST|PATCH|PUT|DELETE)\b|\/api\/|\bHTTP \d{3}\b|status \d{3}/;
const port = { active: () => false, start: () => true };
const visible = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("no transport guidance reaches the pane", () => {
  it("the HTTP path: the catalogue's capacity text is worded for a person", () => {
    const html = renderToStaticMarkup(<PaneFailureNote failure={{ code: "assistant_capacity", message: ERROR_CATALOGUE.assistant_capacity }} pendingActions={1} onDismiss={() => {}} />);
    expect(ERROR_CATALOGUE.assistant_capacity).toMatch(TRANSPORT);
    expect(visible(html)).not.toMatch(TRANSPORT);
    expect(visible(html)).toMatch(/pending action/i);
  });
  it("the stream path: an error event carrying the reservation sentence", () => {
    const html = renderToStaticMarkup(<PaneFailureNote failure={{ code: "assistant_reservation_required", message: ERROR_CATALOGUE.assistant_reservation_required }} pendingActions={0} onDismiss={() => {}} />);
    expect(visible(html)).not.toMatch(TRANSPORT);
  });
  it("the action-result path: a refusal whose body carries seeded transport text", () => {
    const html = renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} failureWords={(f) => failureWords(f, { pendingActions: 0 })} entries={[
      { id: "a", tool: "update_map", label: "Updated the map M", status: "refused", inputs: [], omitted: false,
        failure: { code: "assistant_capacity", message: "Seeded: read GET /api/assistant/pending and DELETE /api/assistant/runs/{id}; HTTP 409" } },
    ]} />);
    expect(visible(html)).not.toMatch(TRANSPORT);
  });
  it("the recovery path: a receipt error carrying seeded transport text", () => {
    const html = renderToStaticMarkup(<PaneFailureNote failure={{ code: "assistant_run_unavailable", message: "Seeded: retry with GET /api/assistant/runs/{id} after status 404" }} pendingActions={0} onDismiss={() => {}} />);
    expect(visible(html)).not.toMatch(TRANSPORT);
  });
});

describe("a SQL error's own text survives", () => {
  it("keeps its numbers and identifiers", () => {
    const message = 'Binder Error: Referenced column "area_m2" not found in FROM clause! Candidate bindings: "area_ha" LINE 1: SELECT area_m2 FROM parks';
    expect(failureWords({ code: "sql_error", message }, { pendingActions: 0 })).toBe(message);
    expect(failureWords({ code: "query_timeout", message: ERROR_CATALOGUE.query_timeout }, { pendingActions: 0 })).toBe(ERROR_CATALOGUE.query_timeout);
  });
});

describe("capacity", () => {
  it("names the person's own share when that is what is full, and the instance's otherwise", () => {
    const own = failureWords({ code: "assistant_capacity", message: ASSISTANT_ACCOUNT_CAPACITY }, { pendingActions: 0 });
    expect(own).toBe("You have four requests open, the most one person may. Wait for one to finish, then send again.");
    expect(failureWords({ code: "assistant_capacity", message: ASSISTANT_ACCOUNT_CAPACITY }, { pendingActions: 1 })).toBe("You have four requests open, the most one person may. Recover a pending action below, or abandon it, to free one.");
    expect(failureWords({ code: "assistant_capacity", message: ERROR_CATALOGUE.assistant_capacity }, { pendingActions: 0 })).toContain("eight requests are open on this instance");
  });
  it("words the reservation limit for a person, with no method or path", () => {
    const words = failureWords({ code: "assistant_reservation_limit", message: ERROR_CATALOGUE.assistant_reservation_limit }, { pendingActions: 0 });
    expect(ERROR_CATALOGUE.assistant_reservation_limit).toMatch(TRANSPORT);
    expect(words).not.toMatch(TRANSPORT);
    expect(words).toBe("Two of your messages have not started yet. Wait a few minutes, then send again.");
  });
  it("with a pending action offers its recovery; with none says something true and offers nothing", () => {
    const withPending = failureWords({ code: "assistant_capacity", message: ERROR_CATALOGUE.assistant_capacity }, { pendingActions: 2 });
    const without = failureWords({ code: "assistant_capacity", message: ERROR_CATALOGUE.assistant_capacity }, { pendingActions: 0 });
    expect(withPending).toMatch(/recover|abandon/i);
    expect(without).not.toMatch(/recover|abandon|below/i);
    expect(without).toMatch(/wait/i);
    for (const words of [withPending, without]) { expect(words).not.toMatch(TRANSPORT); expect(words).not.toContain("—"); }
  });
});

describe("the pane's own notes", () => {
  it("pass through unchanged, and an unknown code keeps its text", () => {
    expect(failureWords({ code: "pane", message: "The message wasn't started. You can send it again." }, { pendingActions: 0 })).toBe("The message wasn't started. You can send it again.");
    expect(failureWords({ code: "not_found", message: "No layer with id l1." }, { pendingActions: 0 })).toBe("No layer with id l1.");
  });
});

describe("the catalogue's texts are unchanged", () => {
  it("every assistant, pending and internal text reads as captured at the red commit", () => {
    expect({
      assistant_reservation_required: ERROR_CATALOGUE.assistant_reservation_required,
      assistant_run_unavailable: ERROR_CATALOGUE.assistant_run_unavailable,
      assistant_run_conflict: ERROR_CATALOGUE.assistant_run_conflict,
      assistant_capacity: ERROR_CATALOGUE.assistant_capacity,
      assistant_run_state: ERROR_CATALOGUE.assistant_run_state,
      assistant_submission_too_large: ERROR_CATALOGUE.assistant_submission_too_large,
      assistant_recovery_limit: ERROR_CATALOGUE.assistant_recovery_limit,
      assistant_plan_unavailable: ERROR_CATALOGUE.assistant_plan_unavailable,
      assistant_action_uncertain: ERROR_CATALOGUE.assistant_action_uncertain,
      assistant_action_interrupted: ERROR_CATALOGUE.assistant_action_interrupted,
      assistant_context_invalid: ERROR_CATALOGUE.assistant_context_invalid,
      assistant_context_too_large: ERROR_CATALOGUE.assistant_context_too_large,
      assistant_context_unavailable: ERROR_CATALOGUE.assistant_context_unavailable,
      assistant_disabled: ERROR_CATALOGUE.assistant_disabled,
      assistant_auth: ERROR_CATALOGUE.assistant_auth,
      assistant_provider: ERROR_CATALOGUE.assistant_provider,
      pending_unknown: ERROR_CATALOGUE.pending_unknown,
      pending_resolved: ERROR_CATALOGUE.pending_resolved,
      pending_superseded: ERROR_CATALOGUE.pending_superseded,
      internal: ERROR_CATALOGUE.internal,
    }).toEqual({
      assistant_reservation_required: "Reserve a run with POST /api/assistant/runs, then send its id as runId.",
      assistant_run_unavailable: "This run identity is unavailable and cannot execute.",
      assistant_run_conflict: "This run identity is already bound to different input.",
      assistant_capacity: "Eight assistant runs are running or waiting for confirmation. Your reservation stays for a retry. Read GET /api/assistant/pending; abandon a pending turn with DELETE /api/assistant/runs/{id}, or wait for one to finish.",
      assistant_run_state: "This operation is not available in the current run state.",
      assistant_submission_too_large: "The assistant submission exceeds 128 KiB.",
      assistant_recovery_limit: "Further work stopped before the live recovery bound could be exceeded.",
      assistant_plan_unavailable: "The current workflow membership could not be established. No run was approved or started.",
      assistant_action_uncertain: "The action outcome could not be established. Its declared resources may have changed.",
      assistant_action_interrupted: "The read was interrupted before completion.",
      assistant_context_invalid: "The submitted page context is malformed or refers to an incompatible object.",
      assistant_context_too_large: "Page context exceeds 64 KiB of UTF-8 JSON.",
      assistant_context_unavailable: "The page context could not be read from this instance.",
      assistant_disabled: "The assistant has no key to answer you with: you have none of your own and the instance has none.",
      assistant_auth: "A model key was rejected by its provider: your own, or the instance's. The message says which.",
      assistant_provider: "The model provider request failed (outage, quota, or network).",
      pending_unknown: "The referenced pending action is unknown; it may have expired with the server's working state.",
      pending_resolved: "The referenced pending action was already resolved; it will not run again.",
      pending_superseded: "A newer message superseded the referenced pending action, declining it.",
      internal: "An unexpected server error occurred.",
    });
    expect(ERROR_CATALOGUE.assistant_action_not_admitted.startsWith("The run's page context does not admit this operation; nothing was performed.")).toBe(true);
  });
});
