import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A port the canvas hides keeps its box, read from the live stylesheet.
 * The flow library places each end of a link from its port's measured
 * box, and a port with no box measures at the canvas's corner, so a link
 * from a port hidden with display: none folds there. The browser journey
 * draws the links; this holds the rule where no layout is computed.
 */

const SHEET = readFileSync("src/components/workflow-canvas/WorkflowCanvas.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule whose selector names a port or the SQL node's side. */
const portRules = [...SHEET.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim().replace(/\s+/g, " "), body }))
  .filter(({ selector }) => /\.(port|sqlSide)\b/.test(selector));

const declares = (body: string, property: string, value: string) =>
  body.split(";").some((part) => {
    const [name, ...rest] = part.split(":");
    return name.trim() === property && rest.join(":").trim() === value;
  });

describe("a hidden port keeps its box", () => {
  it("no rule takes a port's box away", () => {
    expect(portRules.filter(({ body }) => declares(body, "display", "none")).map(({ selector }) => selector)).toEqual([]);
  });

  it("a missing table's port and a locked canvas's ports are hidden by visibility, out of reach", () => {
    for (const selector of [".member .port[data-off]", ".host[data-locked] .port, .host[data-locked] .sqlSide"]) {
      const rule = portRules.find((r) => r.selector === selector);
      expect(rule, selector).toBeDefined();
      expect(declares(rule!.body, "visibility", "hidden"), selector).toBe(true);
      expect(declares(rule!.body, "pointer-events", "none"), selector).toBe(true);
    }
  });
});
