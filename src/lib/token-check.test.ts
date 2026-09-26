import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS CI script, no declaration file on purpose.
import {
  definitionsIn,
  judge,
  scriptDefinitionCredits,
  undefinedReferences,
} from "../../scripts/check-tokens.mjs";

const GLOBALS = definitionsIn(":root { --fg: #243230; --text-body: 13px; }");

describe("undefined token references", () => {
  it("passes a globally defined token", () => {
    expect(
      undefinedReferences(".label { color: var(--fg); }", "fixture.module.css", GLOBALS),
    ).toEqual([]);
  });

  it("fails an undefined reference with its file and token", () => {
    expect(
      undefinedReferences(".label { color: var(--missing); }", "fixture.module.css", GLOBALS),
    ).toEqual([{ file: "fixture.module.css", token: "--missing", line: 1 }]);
  });

  it("passes a custom property defined in the same file", () => {
    expect(
      undefinedReferences(
        ".label { --local: #fff; color: var(--local); }",
        "fixture.module.css",
        GLOBALS,
      ),
    ).toEqual([]);
  });

  it("passes a TSX object-literal definition credit", () => {
    const credits = scriptDefinitionCredits(
      'const style = { "--runtime-fill": percentage };',
    );
    expect(
      undefinedReferences(
        ".bar { width: var(--runtime-fill); }",
        "fixture.module.css",
        new Set([...GLOBALS, ...credits]),
      ),
    ).toEqual([]);
  });

  it("passes a defined head token when the reference also has a fallback", () => {
    expect(
      undefinedReferences(
        ".label { color: var(--fg, hotpink); }",
        "fixture.module.css",
        GLOBALS,
      ),
    ).toEqual([]);
  });

  it("replays an undefined font token fails even with a fallback", () => {
    expect(
      undefinedReferences(
        ".label { font-family: var(--mono, monospace); }",
        "historical.module.css",
        GLOBALS,
      ),
    ).toEqual([{ file: "historical.module.css", token: "--mono", line: 1 }]);
  });

  it("ignores a commented-out reference", () => {
    expect(
      undefinedReferences(
        "/* .old { color: var(--retired); } */\n.label { color: var(--fg); }",
        "fixture.module.css",
        GLOBALS,
      ),
    ).toEqual([]);
  });

  it("replays the historical --text-section defect is rejected", () => {
    const unrelatedCredits = scriptDefinitionCredits(
      'const style = { "--some-other-token": value };',
    );
    expect(
      undefinedReferences(
        ".section { color: var(--text-section); }",
        "historical.module.css",
        new Set([...GLOBALS, ...unrelatedCredits]),
      ),
    ).toEqual([
      { file: "historical.module.css", token: "--text-section", line: 1 },
    ]);
  });
});

describe("definition credit contexts", () => {
  it("does not credit a CLI flag string as a custom-property definition", () => {
    const credits = scriptDefinitionCredits(
      'const args = ["--force", "--no-sandbox"];',
    );
    expect(
      undefinedReferences(
        ".forced { color: var(--force); }",
        "fixture.module.css",
        credits,
      ),
    ).toEqual([{ file: "fixture.module.css", token: "--force", line: 1 }]);
  });

  it("credits next/font variable properties and CSSOM property writes", () => {
    expect(
      scriptDefinitionCredits(
        'const font = load({ variable: "--font-runtime" }); el.style.setProperty("--offset", value);',
      ),
    ).toEqual(new Set(["--font-runtime", "--offset"]));
  });

  it("does not treat a selector suffix as a CSS declaration", () => {
    const definitions = definitionsIn(
      ".tab--active:hover { color: var(--active); }",
    );
    expect(definitions.has("--active")).toBe(false);
    expect(
      undefinedReferences(
        ".tab--active:hover { color: var(--active); }",
        "fixture.module.css",
        GLOBALS,
      ),
    ).toEqual([{ file: "fixture.module.css", token: "--active", line: 1 }]);
  });
});

describe("the inventory ratchet", () => {
  it("rejects new and stale findings", () => {
    const rows = [{ file: "new.module.css", token: "--new", count: 1 }];
    const inventory = [{ file: "old.module.css", token: "--old", count: 1 }];
    expect(judge(rows, inventory)).toEqual([
      "NEW: new.module.css - --new x1",
      "STALE: old.module.css - --old listed x1, found x0 (heal the inventory in the same change)",
    ]);
  });
});
