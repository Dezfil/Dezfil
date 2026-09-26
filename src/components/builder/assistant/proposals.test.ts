import { describe, expect, it } from "vitest";
import { segmentReply, sqlProposals } from "./proposals";

/** Criterion 6c's arithmetic: zero, one and two completed SQL-marked
 * blocks give zero, one and two proposals with their exact text; a
 * block still streaming gives none until its fence closes. */
describe("SQL proposals in a reply", () => {
  it("finds zero, one and two completed SQL-marked blocks", () => {
    expect(sqlProposals("Just prose, no code.")).toEqual([]);
    expect(sqlProposals("Try this:\n```sql\nSELECT 1;\n```\nDone.")).toEqual([{ index: 1, sql: "SELECT 1;" }]);
    const two = sqlProposals("First:\n```sql\nSELECT 1;\n```\nSecond:\n```SQL\nSELECT 2;\n```");
    expect(two.map((p) => p.sql)).toEqual(["SELECT 1;", "SELECT 2;"]);
    expect(two.map((p) => p.index)).toEqual([1, 3]);
  });
  it("keeps comments and literal semicolons as one block with its exact text", () => {
    const sql = "-- keep this comment; and this semicolon\nSELECT ';' AS s,\n       count(*) AS n\nFROM parks;";
    expect(sqlProposals("```sql\n" + sql + "\n```")).toEqual([{ index: 0, sql }]);
  });
  it("a block still streaming carries no proposal until it completes", () => {
    const streaming = "Here:\n```sql\nSELECT 1";
    expect(sqlProposals(streaming)).toEqual([]);
    const segments = segmentReply(streaming);
    expect(segments[1]).toEqual({ kind: "code", lang: "sql", code: "SELECT 1", complete: false });
    expect(sqlProposals(streaming + ";\n```")).toEqual([{ index: 1, sql: "SELECT 1;" }]);
  });
  it("prose and other code blocks are not proposals", () => {
    const text = "```json\n{\"a\": 1}\n```\n```\nSELECT 1;\n```\nSELECT 2; in prose";
    expect(sqlProposals(text)).toEqual([]);
    expect(segmentReply(text).map((s) => s.kind === "code" ? s.lang : "text")).toEqual(["json", null, "text"]);
  });
  it("a tilde fence closes a tilde fence and a longer backtick fence closes a shorter one", () => {
    expect(sqlProposals("~~~sql\nSELECT 1;\n~~~")).toEqual([{ index: 0, sql: "SELECT 1;" }]);
    expect(sqlProposals("```sql\nSELECT 1;\n````")).toEqual([{ index: 0, sql: "SELECT 1;" }]);
    expect(sqlProposals("```sql\nSELECT 1;\n~~~")).toEqual([]);
  });
});
