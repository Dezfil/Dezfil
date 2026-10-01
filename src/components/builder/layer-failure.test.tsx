import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { memberWord, type RunMember } from "../workflow-canvas/run-overlay";
import { PanelFailureNotes } from "./style-panel/PanelFailureNotes";

/**
 * A layer whose SQL names a dataset the reader cannot reach fails with the
 * resource diagnostic: the name as written, "not available to you". The
 * shipped failure note leads with that sentence, since it is the product's
 * own and says what to fix, instead of the catalogue's generic line with
 * the diagnostic one click deeper. Any other failure keeps its shape. A
 * workflow step already wears the API's words.
 */

const unavailable = { code: "sql_error", message: 'The dataset "ada.roads" is not available to you.' };
const engine = { code: "sql_error", message: "Binder Error: Referenced column \"x\" not found" };
const html = (error: { code: string; message: string }) =>
  renderToStaticMarkup(<PanelFailureNotes renderError={error} channelError={null} onDismissChannelError={() => {}} />);

describe("the missing-dataset failure note", () => {
  it("leads with the name as written and that it is not available to you", () => {
    const note = html(unavailable);
    expect(note).toContain("The dataset &quot;ada.roads&quot; is not available to you.");
    expect(note).not.toContain(ERROR_CATALOGUE.sql_error);
    expect(note).not.toContain("Technical detail");
    expect(note).toContain("data-render-error");
  });

  it("keeps any other failure in the catalogue's words with the detail behind the disclosure", () => {
    const note = html(engine);
    expect(note).toContain(ERROR_CATALOGUE.sql_error);
    expect(note).toContain("Technical detail");
  });

  it("does not take a look-alike for the diagnostic", () => {
    const note = html({ code: "sql_error", message: 'The dataset "roads" is not available to you. Also: Binder Error' });
    expect(note).toContain(ERROR_CATALOGUE.sql_error);
  });

  it("gives a failed workflow step the same sentence, in the API's words", () => {
    const member: RunMember = {
      stepId: "s1", ordinal: 0, operation: "buffer", name: "near", state: "failed", jobId: "j", stoppedBy: null,
      stoppedReason: null, output: null,
      attempt: { state: "failed", error: unavailable, acceptedAt: "t", startedAt: "t", finishedAt: "t", output: null },
    };
    expect(memberWord(member).reason).toBe(unavailable.message);
  });
});
