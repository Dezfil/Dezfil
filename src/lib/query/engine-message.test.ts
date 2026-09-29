import { describe, expect, it } from "vitest";
import { enginePosition, offsetPosition, stripStatementQuote } from "./engine-message";

describe("stripStatementQuote", () => {
  it("drops the quoted statement and caret, keeps the diagnosis", () => {
    const message = [
      'Binder Error: Referenced column "nope" not found in FROM clause!',
      'Candidate bindings: "q.riders"',
      "LINE 1: DESCRIBE SELECT * FROM (SELECT nope FROM t) AS q",
      "                                               ^",
    ].join("\n");
    expect(stripStatementQuote(message)).toBe(
      [
        'Binder Error: Referenced column "nope" not found in FROM clause!',
        'Candidate bindings: "q.riders"',
      ].join("\n"),
    );
  });

  it("leaves a message without a statement quote untouched", () => {
    const message = "Out of Memory Error: could not allocate block";
    expect(stripStatementQuote(message)).toBe(message);
  });

  it("only strips the quote block, never a LINE mention mid-sentence", () => {
    const message = 'Binder Error: column "LINE 1:" not found';
    expect(stripStatementQuote(message)).toBe(message);
  });

  it("keeps a diagnostic line that starts with LINE but has no caret", () => {
    // Reachable content: SELECT error('first' || chr(10) || 'LINE 1: keep')
    const message = "Invalid Error: first\nLINE 1: keep this detail";
    expect(stripStatementQuote(message)).toBe(message);
  });
});

describe("enginePosition", () => {
  const prefix = "DESCRIBE SELECT * FROM (";
  it("maps a line-one caret through the probe wrapper", () => {
    const message = [
      "Catalog Error: Table with name nope does not exist!",
      'Did you mean "pg_enum"?',
      "",
      "LINE 1: DESCRIBE SELECT * FROM (SELECT * FROM nope) AS q",
      "                                              ^",
    ].join("\n");
    // "SELECT * FROM nope": the token starts at column 15.
    expect(enginePosition(message, prefix)).toEqual({ line: 1, column: 15 });
  });

  it("maps a later line's caret directly", () => {
    const message = [
      "Catalog Error: Table with name nope does not exist!",
      "",
      "LINE 2: FROM nope) AS q",
      "             ^",
    ].join("\n");
    expect(enginePosition(message, prefix)).toEqual({ line: 2, column: 6 });
  });

  it("maps a parser error on line three", () => {
    const message = [
      'Parser Error: syntax error at or near ")"',
      "LINE 3: WHERE name = ) AS q",
      "                     ^",
    ].join("\n");
    expect(enginePosition(message, prefix)).toEqual({ line: 3, column: 14 });
  });

  it("yields null without a caret block, or when line one is not the probe", () => {
    expect(enginePosition("Out of Memory Error: could not allocate", prefix)).toBeNull();
    const other = [
      "Parser Error: syntax error",
      "LINE 1: SELECT count(*) AS n FROM (SELECT 1 +) AS q",
      "                                             ^",
    ].join("\n");
    expect(enginePosition(other, prefix)).toBeNull();
  });

  it("yields null when the caret sits inside the wrapper itself", () => {
    const message = [
      "Parser Error: syntax error",
      "LINE 1: DESCRIBE SELECT * FROM (SELECT 1) AS q",
      "        ^",
    ].join("\n");
    expect(enginePosition(message, prefix)).toBeNull();
  });
});

describe("offsetPosition", () => {
  it("turns a parser offset into a 1-based line and column", () => {
    expect(offsetPosition("SELECT name FROMM stations", "18")).toEqual({ line: 1, column: 19 });
    expect(offsetPosition("SELECT *\nFROM stations\nWHERE name = ", "36")).toEqual({ line: 3, column: 14 });
    expect(offsetPosition("SELECT 1 +", 10)).toEqual({ line: 1, column: 11 });
  });
  it("yields null for an unusable offset", () => {
    expect(offsetPosition("SELECT 1", undefined)).toBeNull();
    expect(offsetPosition("SELECT 1", "x")).toBeNull();
    expect(offsetPosition("SELECT 1", -1)).toBeNull();
  });
});

describe("safe query failures", () => {
  it("omits catalogue suggestions and normalizes all absent relations", async () => {
    const { safeEngineMessage } = await import("./engine-message");
    for (const kind of ["Table", "Schema", "Catalog"]) {
      expect(safeEngineMessage(`Catalog Error: ${kind} with name private_name does not exist!\nDid you mean "hidden_schema"?`))
        .toBe("The query refers to an unknown table.");
    }
    expect(safeEngineMessage('Binder Error: Referenced column "value" not found.\nCandidate bindings: "hidden_name"'))
      .toBe('Binder Error: Referenced column "value" not found.');
  });
  it("keeps file paths and engine traces out of query failures", async () => {
    const { safeEngineMessage, normalizeEngineError } = await import("./engine-message");
    const { ApiError } = await import("@/lib/api/errors");
    for (const message of [
      'IO Error: Cannot open file "/private/hidden/secret.parquet"',
      'Invalid Input Error: No magic bytes at end of file "C:\\private\\secret.parquet"',
      'Internal Error: failed at /source/native.cpp\nStack Trace: private',
      'Binder Error: failed for "\\\\private\\connection"',
    ]) expect(safeEngineMessage(message)).not.toMatch(/private|secret|native|Stack|parquet|connection/);
    const error = normalizeEngineError(new ApiError("sql_error", "Binder Error: input invalid", 400, {
      position: { line: 2, column: 3, hidden: "secret" }, path: "/private/secret", owner: "hidden",
    }));
    expect(error).toMatchObject({ code: "sql_error", extra: { position: { line: 2, column: 3 } } });
    expect((error as InstanceType<typeof ApiError>).extra).toEqual({ position: { line: 2, column: 3 } });
  });
});
