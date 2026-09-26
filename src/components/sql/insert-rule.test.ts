import { describe, expect, it } from "vitest";
import { insertProposal } from "./insert-rule";

/** D1's rule: replace only an unchanged draft; otherwise
 * preserve, append below with a blank line, and select the appended text.
 * The editor's single undo step is the browser suite's. */
describe("Insert into editor", () => {
  const origin = "SELECT * FROM parks LIMIT 100;";
  const proposal = "SELECT p.name FROM parks p;";
  it("replaces the draft that still equals the request's draft", () => {
    expect(insertProposal(origin, origin, proposal)).toEqual({ text: proposal, from: 0, to: proposal.length, outcome: "replaced" });
  });
  it("preserves a draft that changed since the request, appends below it and selects the proposal", () => {
    const edited = origin + "\n-- edited";
    const write = insertProposal(edited, origin, proposal);
    expect(write.outcome).toBe("appended");
    expect(write.text).toBe(edited + "\n\n" + proposal);
    expect(write.text.slice(write.from, write.to)).toBe(proposal);
  });
  it("appends after one blank line when the draft already ends in a newline, and with no gap into an empty draft", () => {
    expect(insertProposal(origin + "\n", origin, proposal).text).toBe(origin + "\n\n" + proposal);
    const empty = insertProposal("", origin, proposal);
    expect(empty).toEqual({ text: proposal, from: 0, to: proposal.length, outcome: "appended" });
  });
  it("compares the whole draft, so a draft loaded from History or Open as SQL since the request appends", () => {
    expect(insertProposal("SELECT 1;", origin, proposal).outcome).toBe("appended");
    expect(insertProposal(proposal, origin, proposal).outcome).toBe("appended");
  });
});
