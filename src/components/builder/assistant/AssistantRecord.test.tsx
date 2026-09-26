import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantRecord, OMITTED_NOTE } from "./AssistantRecord";
import type { RecordEntry } from "./record-projection";

/** The record's rendering:
 * the line holds the words, the outcome and the time and never the
 * identifier; a refusal's reason reads under it; the inspection is
 * closed by default. Expander behavior and the open inspection are
 * browser cases (task 28). */
const port = { active: () => false, start: () => true };
const entry = (over: Partial<RecordEntry>): RecordEntry => ({ id: "e", tool: "update_layer", label: "Updated the layer Parks", status: "succeeded", inputs: [["id", "l1"]], omitted: false, ...over });

describe("the action record", () => {
  it("renders one collapsed line per entry with the words, the outcome word, the elapsed time, and no identifier", () => {
    const html = renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} entries={[
      entry({ id: "a", elapsed: "0.4 s" }),
      entry({ id: "b", tool: "run_sql", label: "Ran a query", status: "refused", sql: "SELECT 1", inputs: [], failure: { code: "sql_error", message: "Binder Error at line 1" } }),
      entry({ id: "c", tool: "run_recipe", label: "Ran the workflow Flow", status: "accepted", jobId: "job-7" }),
      entry({ id: "d", tool: "create_map", label: "Created the map", status: "uncertain", failure: { code: "assistant_action_uncertain", message: "The outcome is uncertain. Check the affected data." } }),
      entry({ id: "r", tool: "list_tables", label: "Listed the datasets", status: "running" }),
    ]} />);
    expect(html.match(/data-record-entry=/g)).toHaveLength(5);
    expect(html).toContain("Updated the layer Parks");
    expect(html).toContain("0.4 s");
    expect(html).toContain('data-status="refused"');
    expect(html).toContain("Binder Error at line 1");
    expect(html).toContain("Accepted as a job: job-7.");
    expect(html).toContain("The outcome is uncertain.");
    expect(html).toContain('aria-label="in progress"');
    // Closed by default: no inspection, so the identifiers stay off the
    // lines' visible text (the wrapper's data attribute is a locator, not copy).
    expect(html).not.toContain("data-inspection");
    const visible = html.replace(/<[^>]+>/g, " ");
    expect(visible).not.toContain("update_layer");
    expect(visible).not.toContain("run_sql");
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(5);
  });
  it("words a failure through the boundary it is given", () => {
    const html = renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} failureWords={(f) => `[${f.code}] worded`} entries={[
      entry({ status: "refused", failure: { code: "assistant_capacity", message: "Read GET /api/assistant/pending" } }),
    ]} />);
    expect(html).toContain("[assistant_capacity] worded");
    expect(html).not.toContain("GET /api");
  });
  it("words a settled gate's inspection by its origin: stopped by you, or ended before it was confirmed, never a newer message it did not have", () => {
    const stopped = renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} entries={[
      entry({ id: "confirmation:p1", tool: "publish_map", label: "Publish Evening (m1)", status: "refused", decision: "superseded", failure: { code: "stopped", message: "You stopped the request, so this was not done." } }),
    ]} open={["confirmation:p1"]} />);
    expect(stopped).toContain("Stopped by you.");
    expect(stopped).not.toContain("next message");
    const recovered = renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} entries={[
      entry({ id: "confirmation:p2", tool: "publish_map", label: "Publish Evening (m1)", status: "refused", decision: "superseded", failure: { code: "superseded", message: "The request ended before this was confirmed, so it was not done." } }),
    ]} open={["confirmation:p2"]} />);
    expect(recovered).toContain("Ended before it was confirmed.");
    expect(recovered).not.toContain("next message");
    expect(renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} entries={[entry({ id: "d", decision: "declined", status: "refused" })]} open={["d"]} />)).toContain("Cancelled by you.");
  });
  it("d: the collapsed line carries the whole sentence as pointer text and in its accessible name, at a long subject and a short one", () => {
    // The sentences are supplied here, never read back out of the entry the
    // component produced (verification, standing rule 1).
    const long = "Updated the layer Dynamic park perimeters of the eastern district, 2026 survey";
    const short = "Ran a query";
    const html = renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} entries={[
      entry({ id: "long", label: long, elapsed: "0.4 s" }),
      entry({ id: "short", tool: "run_sql", label: short, sql: "SELECT 1", inputs: [] }),
    ]} />);
    for (const sentence of [long, short]) {
      // Pointer text: the whole sentence, on the line a pointer rests over.
      expect(html).toContain(`title="${sentence}"`);
      // Accessible name: the line's own words, whole, not a shortened label.
      expect(html).toContain(`>${sentence}</span>`);
    }
  });
  it("renders nothing for an empty record and keeps the omitted note ready", () => {
    expect(renderToStaticMarkup(<AssistantRecord layerDataDownloads={port} entries={[]} />)).toBe("");
    expect(OMITTED_NOTE).not.toContain("—");
  });
});
