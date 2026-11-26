import { describe, expect, it } from "vitest";
import { DATASET_READ_MESSAGE, DatasetUnavailable, UNKNOWN_TABLE_MESSAGE, safeEngineMessage } from "./engine-message";
import { splitEngineWords } from "./engine-words";

/**
 * A failure message carries the engine's own words when the engine
 * wrote it: DuckDB opens each error with its kind, "Binder Error: …".
 * Those words are shown as written; the app's sentence before them, and
 * the sentences the app writes in their place, are the app's.
 */
describe("the engine's words in a failure message", () => {
  it("are the whole message the engine wrote", () => {
    for (const message of [
      'Binder Error: Referenced column "nope" not found in FROM clause!',
      'Parser Error: syntax error at or near "FORM"',
      "Catalog Error: Scalar Function with name st_buffr does not exist!",
      "Conversion Error: Could not convert string 'Mitte' to INT32",
      "Out of Range Error: Overflow in multiplication of INT32 (2147483647 * 2)!",
      "Invalid Input Error: Malformed JSON at byte 3",
      "Not implemented Error: Unsupported join type",
      "INTERRUPT Error: Interrupted!",
    ]) {
      expect(splitEngineWords(message)).toEqual({ lead: "", engine: message });
    }
  });

  it("keep their later lines with them", () => {
    const message = "Binder Error: Table \"p\" does not have a column named \"nme\"\n\nLINE 1 is gone";
    expect(splitEngineWords(message)).toEqual({ lead: "", engine: message });
  });

  it("are what follows the app's own sentence before them", () => {
    expect(splitEngineWords(' failed. Binder Error: Referenced column "nope" not found in FROM clause!')).toEqual({
      lead: " failed. ",
      engine: 'Binder Error: Referenced column "nope" not found in FROM clause!',
    });
    expect(splitEngineWords("Buffer not run. Conversion Error: Could not convert string 'x' to DOUBLE")).toEqual({
      lead: "Buffer not run. ",
      engine: "Conversion Error: Could not convert string 'x' to DOUBLE",
    });
  });

  it("are a diagnosis the server passed on as it was", () => {
    const message = safeEngineMessage('Binder Error: Referenced column "nope" not found in FROM clause!\nCandidate bindings: "name"');
    expect(splitEngineWords(message)).toEqual({ lead: "", engine: 'Binder Error: Referenced column "nope" not found in FROM clause!' });
  });

  it("are none in the sentences the app writes in their place", () => {
    for (const message of [
      UNKNOWN_TABLE_MESSAGE,
      DATASET_READ_MESSAGE,
      safeEngineMessage("Internal Error: something deep"),
      new DatasetUnavailable("jonas_weber.parks").message,
      "Could not reach the server.",
      " failed. The run failed.",
      " not run. A node it depends on did not succeed.",
      "Run all · 3 nodes",
      "Partly completed · 2 of 3 succeeded",
    ]) {
      expect(splitEngineWords(message)).toEqual({ lead: message, engine: null });
    }
  });

  it("are none where an error kind only appears inside a sentence", () => {
    for (const message of [
      "The import met an IO Error: and stopped.",
      "Name the Binder Error: column first.",
      "The query could not be completed.",
    ]) {
      expect(splitEngineWords(message)).toEqual({ lead: message, engine: null });
    }
  });
});
