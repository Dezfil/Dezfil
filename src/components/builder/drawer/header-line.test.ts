import { describe, expect, it } from "vitest";
import { cssRules } from "../../testing/css-rules";

/**
 * The Tools drawer's header, and the Assistant pane's that composes it,
 * draw their underline on the inspector tab strip's line. The two panels
 * stand at the same top; the strip reaches its border through the panel's
 * own top inset, the strip's padding and the kit's tab, the header through
 * the drawer's top inset and its own height, which counts its border (the
 * base reset sizes every box by its border edge). The drawer floats as the
 * inspector's glass and draws no edge, so whatever inset it needs is
 * padding, never a line. The browser cases in e2e/pane-replacement.spec.ts
 * measure the rendered boxes; this holds the declarations they come from.
 */

const GLOBALS = "src/app/globals.css";
const RAIL = "src/components/builder/MapBuilder.module.css";
const TABS = "src/components/ui/Tabs.module.css";
const DRAWER = "src/components/builder/drawer/RecipeDrawer.module.css";
const HEADER = "src/components/builder/drawer/FaceHeader.module.css";
const PANE = "src/components/builder/assistant/AssistantPane.module.css";

const declaration = (body: string, property: string) =>
  body.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`))?.[1].trim();

/** The one rule of `file` for `selector` that declares `property`. */
function bodyOf(file: string, selector: string, property: string): string {
  const found = cssRules(file).filter((r) => r.selector === selector && declaration(r.body, property) !== undefined);
  expect(found.map((r) => r.selector), `${file} ${selector} ${property}`).toHaveLength(1);
  return found[0].body;
}

function px(value: string | undefined, what: string): number {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value ?? "");
  expect(m, `${what} is a pixel length, not ${value}`).not.toBeNull();
  return Number(m![1]);
}

/** A side's padding over every rule of `selector` in `file`: the longhand
 * where one is written, else the shorthand's value for that side, 0 where
 * neither is. */
function paddingOf(file: string, selector: string, side: "top" | "bottom"): number {
  let found = 0;
  for (const { body } of cssRules(file).filter((r) => r.selector === selector)) {
    const long = declaration(body, `padding-${side}`);
    const short = declaration(body, "padding")?.split(/\s+/);
    if (long !== undefined) found = px(long, `${selector} padding-${side}`);
    else if (short) found = px(side === "top" ? short[0] : (short[2] ?? short[0]), `${selector} padding`);
  }
  return found;
}

/** A side's border width over every rule of `selector` in `file`, 0 where
 * none is drawn. */
function borderOf(file: string, selector: string, side: "top" | "bottom"): number {
  let found = 0;
  for (const { body } of cssRules(file).filter((r) => r.selector === selector)) {
    for (const property of ["border", `border-${side}`, "border-width", `border-${side}-width`]) {
      const value = declaration(body, property);
      if (value === undefined) continue;
      const width = value.split(/\s+/).find((part) => /^\d+(?:\.\d+)?px$/.test(part) || part === "0");
      found = width === undefined || width === "0" ? 0 : px(width, `${selector} ${property}`);
    }
  }
  return found;
}

describe("the drawer's header line", () => {
  it("lands on the inspector strip's line", () => {
    // Heights below count the border: the base reset's border-box sizing.
    expect(declaration(bodyOf(GLOBALS, "*", "box-sizing"), "box-sizing")).toBe("border-box");

    const railTop = px(declaration(bodyOf(RAIL, ".rail", "top"), "top"), ".rail top");
    const railInset = paddingOf(RAIL, ".rail", "top") + borderOf(RAIL, ".rail", "top");
    const tab = px(declaration(bodyOf(TABS, ".tab", "height"), "height"), "the kit's tab height");
    const strip = railTop + railInset + paddingOf(RAIL, ".tabs", "top") + tab + borderOf(RAIL, ".tabs", "bottom");

    const drawerTop = px(declaration(bodyOf(DRAWER, ".drawer", "top"), "top"), ".drawer top");
    const drawerInset = paddingOf(DRAWER, ".drawer", "top") + borderOf(DRAWER, ".drawer", "top");
    const header = px(declaration(bodyOf(HEADER, ".head", "height"), "height"), "the header's height");
    expect(borderOf(HEADER, ".head", "bottom"), "the header draws its underline as its bottom border").toBe(1);

    expect(drawerTop + drawerInset + header, `header line at ${drawerTop + drawerInset + header}, strip line at ${strip}`).toBe(strip);
  });

  it("takes its inset as padding, never a drawn line, and the Assistant pane keeps it", () => {
    for (const selector of [".drawer", '.drawer[data-overlay="true"]', '.drawer[data-hidden="true"]']) {
      expect(borderOf(DRAWER, selector, "top"), `${selector} draws no top edge`).toBe(0);
    }
    // The pane is the drawer by composition and adds no inset of its own.
    expect(bodyOf(PANE, ".pane", "composes")).toMatch(/composes:\s*drawer from "\.\.\/drawer\/RecipeDrawer\.module\.css"/);
    for (const { selector } of cssRules(PANE).filter((r) => r.selector.startsWith(".pane"))) {
      expect(paddingOf(PANE, selector, "top"), `${selector} adds no top padding`).toBe(0);
      expect(borderOf(PANE, selector, "top"), `${selector} draws no top edge`).toBe(0);
    }
  });
});
