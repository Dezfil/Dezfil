import { describe, expect, it } from "vitest";
import { DECLINED_NOTE, SUPERSEDED_NOTE, UNCERTAIN, entryFromAction, entryFromCall, entryFromConfirmation, entryFromResult, inputsOf, mergeLiveDetail } from "./record-projection";

/** The projection: expected display values are
 * written here, never read back through the projection. */
describe("the record projection", () => {
  it("projects a live call and its result to one entry with the server's words, elapsed time and history", () => {
    const running = entryFromCall({ type: "tool_call", id: "c1", tool: "update_layer", args: { id: "l1", name: "Parks" }, label: "Updated the layer Parks", subject: { resource: "layers", id: "l1" } });
    expect(running).toEqual({ id: "c1", tool: "update_layer", label: "Updated the layer Parks", status: "running", inputs: [["id", "l1"], ["name", "Parks"]], omitted: false, download: undefined });
    const done = entryFromResult(running, { type: "tool_result", id: "c1", tool: "update_layer", ok: true, body: { id: "l1" }, outcome: "succeeded", label: "Updated the layer Parks", elapsedMs: 240, history: { mapId: "m1", group: "g1" } });
    expect(done).toMatchObject({ id: "c1", status: "succeeded", label: "Updated the layer Parks", elapsed: "0.2 s", inputs: [["id", "l1"], ["name", "Parks"]], history: { mapId: "m1", group: "g1" }, omitted: false });
    expect(done.failure).toBeUndefined();
  });
  it("keeps exactly the submitted SQL apart from the other inputs, and a refusal's own coded text", () => {
    const sql = "SELECT count(*) FROM parks WHERE area > 1";
    const call = entryFromCall({ type: "tool_call", id: "q1", tool: "run_sql", args: { sql }, label: "Ran a query" });
    expect(call.sql).toBe(sql); expect(call.inputs).toEqual([]);
    const refused = entryFromResult(call, { type: "tool_result", id: "q1", tool: "run_sql", ok: false, outcome: "refused", label: "Ran a query",
      body: { error: { code: "sql_error", message: "Binder Error: column \"area\" not found at line 1, column 38" } }, elapsedMs: 12 });
    expect(refused).toMatchObject({ status: "refused", sql, failure: { code: "sql_error", message: "Binder Error: column \"area\" not found at line 1, column 38" }, elapsed: "0.0 s" });
  });
  it("marks omitted detail on a recovered action and shows nothing as what ran", () => {
    const entry = entryFromAction({ id: "a1", tool: "run_sql", status: "succeeded", label: "Ran a query", omitted: true, elapsedMs: 80 });
    expect(entry).toEqual({ id: "a1", tool: "run_sql", label: "Ran a query", status: "succeeded", elapsed: "0.1 s", inputs: [], omitted: true });
    expect(entry.sql).toBeUndefined();
  });
  it("a check whose state detail was dropped projects no counts, one with no visible layers projects zero", () => {
    const facts = { id: "r", mapId: "m", mapName: "M", appearance: "light" as const, state: { map: "m", camera: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 }, legend: { visible: false, corner: "bottom-left" }, appearance: "light" as const, digest: "abcdefabcdefabcd" }, image: { width: 1024, height: 640, bytes: 1 }, source: { width: 1024, height: 640 }, attribution: "", composition: { failures: [], abandoned: [] }, elapsedMs: 1 };
    const dropped = entryFromAction({ id: "look-1", tool: "look_at_map", status: "succeeded", label: "Checked the map", omitted: true, render: facts });
    expect(dropped.check).toMatchObject({ renderId: "r", stateDigest: "abcdefabcdefabcd" });
    expect(dropped.check?.layers).toBeUndefined();
    expect(dropped.check?.widgets).toBeUndefined();
    const empty = entryFromAction({ id: "look-2", tool: "look_at_map", status: "succeeded", label: "Checked the map", render: { ...facts, state: { ...facts.state, layers: [], legend: { ...facts.state.legend, order: [] }, widgets: [] } } });
    expect(empty.check).toMatchObject({ layers: 0, widgets: 0 });
  });
  it("keeps uncertainty, accepted work, refusal and an unfinished action distinguishable on recovery", () => {
    const entries = [
      { id: "u", tool: "create_map", status: "uncertain" as const, label: "Created the map" },
      { id: "j", tool: "run_recipe", status: "accepted" as const, jobId: "job-identity", label: "Ran the workflow Flow" },
      { id: "r", tool: "update_map", status: "refused" as const, label: "Updated the map M" },
      { id: "a", tool: "run_sql", status: "attempted" as const, label: "Ran a query", args: { sql: "SELECT 1" } },
    ].map(entryFromAction);
    expect(entries.map((e) => e.status)).toEqual(["uncertain", "accepted", "refused", "running"]);
    expect(entries[0].failure).toEqual(UNCERTAIN);
    expect(entries[1].jobId).toBe("job-identity");
    expect(entries[2].failure).toEqual({ code: "refused", message: "The action was refused." });
    expect(entries[3].sql).toBe("SELECT 1");
  });
  it("turns a declined and a superseded confirmation into settled entries scoped to the action, and none for an approval", () => {
    const record = { id: "p1", runId: "r", tool: "publish_map", args: { id: "m1" }, confirmation: { target: "Publish Evening (m1)?", consequence: "Anyone with the link can view it." } };
    expect(entryFromConfirmation({ ...record, decision: "declined" })).toMatchObject({ id: "confirmation:p1", label: "Publish Evening (m1)", status: "refused", decision: "declined", failure: { code: "declined", message: DECLINED_NOTE }, inputs: [["id", "m1"]] });
    expect(entryFromConfirmation({ ...record, decision: "superseded" })).toMatchObject({ decision: "superseded", failure: { message: SUPERSEDED_NOTE } });
    expect(entryFromConfirmation({ ...record, decision: "approved" })).toBeUndefined();
    expect(DECLINED_NOTE).not.toMatch(/nothing changed/i);
  });
  it("words a declined call's result with the gate's words and the pane's scoped note", () => {
    const declined = entryFromResult(undefined, { type: "tool_result", id: "g", tool: "publish_map", ok: false, outcome: "refused", decision: "declined", label: "Publish Evening (m1)", body: { note: "The user did not confirm this action, so it was not performed." } });
    expect(declined).toMatchObject({ label: "Publish Evening (m1)", status: "refused", decision: "declined", failure: { code: "declined", message: DECLINED_NOTE } });
  });
  it("keeps a refusal's streamed text on settlement where the receipt has only the generic refusal", () => {
    const streamed = entryFromResult(undefined, { type: "tool_result", id: "q", tool: "run_sql", ok: false, outcome: "refused", label: "Ran a query", body: { error: { code: "sql_error", message: "Binder Error at line 3" } } });
    const receipt = entryFromAction({ id: "q", tool: "run_sql", status: "refused", label: "Ran a query", elapsedMs: 5 });
    const [merged] = mergeLiveDetail([receipt], [streamed]);
    expect(merged.failure).toEqual({ code: "sql_error", message: "Binder Error at line 3" });
    expect(merged.elapsed).toBe("0.0 s");
    // Nothing streamed, or a specific receipt failure: the receipt's entry stands.
    expect(mergeLiveDetail([receipt], [])).toEqual([receipt]);
    const uncertain = entryFromAction({ id: "q", tool: "run_sql", status: "uncertain" });
    expect(mergeLiveDetail([uncertain], [streamed])[0].failure).toEqual(UNCERTAIN);
  });
  it("words inputs compactly and leaves the SQL out of them", () => {
    expect(inputsOf({ id: "l1", sql: "SELECT 1", classes: 3, filters: [{ kind: "range", min: 1 }] })).toEqual([["id", "l1"], ["classes", "3"], ["filters", "[{\"kind\":\"range\",\"min\":1}]"]]);
    expect(inputsOf(undefined)).toEqual([]);
  });
});
