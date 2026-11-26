import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineWords } from "./EngineWords";
import styles from "./EngineWords.module.css";

/**
 * A failure message sets the engine's own words apart from the app's
 * sentence around them, so they can be shown as written; a message with
 * none of the engine's words is the app's sentence, as it was.
 */
describe("a failure message with the engine's words", () => {
  it("sets the engine's words apart, after the app's sentence", () => {
    expect(renderToStaticMarkup(<EngineWords text=' failed. Binder Error: Referenced column "nope" not found in FROM clause!' />)).toBe(
      ` failed. <span class="${styles.engine}">Binder Error: Referenced column &quot;nope&quot; not found in FROM clause!</span>`,
    );
  });

  it("sets a message the engine wrote apart as a whole", () => {
    expect(renderToStaticMarkup(<EngineWords text="Parser Error: syntax error at end of input" />)).toBe(
      `<span class="${styles.engine}">Parser Error: syntax error at end of input</span>`,
    );
  });

  it("leaves the app's own sentence as it is", () => {
    expect(renderToStaticMarkup(<EngineWords text="The query refers to an unknown table." />)).toBe("The query refers to an unknown table.");
  });
});
