import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { BasemapKey } from "@/lib/basemap";
import type { Appearance } from "@/lib/export/image-definition";
import { installDomHost, type HostElement } from "../../testing/dom-host";
import { cssRules, outranks, specificity } from "../../testing/css-rules";
import { buildCompositionMapInputs } from "./composition-map-inputs";
import { ExportComposition } from "./ExportComposition";
import styles from "./ExportComposition.module.css";

/**
 * The credit is drawn straight onto the map, plain haloed text with no card
 * of its own, so its ink and halo have to read against the basemap the image
 * draws rather than the theme the image was made in. Here the composition is
 * mounted as both hosts assemble it, and the colours the credit's own rules
 * read are resolved through the document's stylesheets as a browser would:
 * the rule that reaches the element with the strongest selector, later in
 * the sheets on a tie, else the parent's value.
 */

// The map surface needs a browser and plays no part in the credit's colour.
vi.mock("next/dynamic", () => ({ default: () => () => null }));

/** The sheets every page loads, in the order the document loads them. */
const SHEETS = ["src/app/globals.css", "src/app/look.css", "src/app/look-liquid.css", "src/app/look-paper.css"];
const CONDITIONAL = /@(?:media|supports)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g;
type TokenRule = { selector: string; order: number; tokens: Map<string, string> };
const TOKEN_RULES: TokenRule[] = SHEETS.flatMap((file, sheet) => {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(CONDITIONAL, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body], index) => {
    const tokens = new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map(([, name, value]) => [name, value.trim()]));
    return selectors.split(",").map((selector) => ({ selector: selector.trim().replace(/\s+/g, " "), order: sheet * 100_000 + index, tokens }));
  });
});

/** One compound of the forms the token rules use: `:root`, then attribute parts. */
function fits(compound: string, el: HostElement, root: HostElement): boolean {
  const m = /^(:root)?((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(compound);
  if (!m) throw new Error(`the resolver does not read "${compound}"`);
  if (m[1] && el !== root) return false;
  return !m[2] || el.matches(m[2]);
}

/** Whether a descendant selector reaches the element. */
function reaches(selector: string, el: HostElement, root: HostElement): boolean {
  const compounds = selector.split(" ");
  if (!fits(compounds[compounds.length - 1], el, root)) return false;
  let up = el.parentElement;
  for (let i = compounds.length - 2; i >= 0; i--) {
    while (up && !fits(compounds[i], up, root)) up = up.parentElement;
    if (!up) return false;
    up = up.parentElement;
  }
  return true;
}

/** A token's value on an element: declared there by the winning rule, or inherited. */
function resolve(token: string, el: HostElement, root: HostElement): string | undefined {
  for (let node: HostElement | null = el; node; node = node.parentElement) {
    const here = TOKEN_RULES.filter((rule) => rule.tokens.has(token) && reaches(rule.selector, node!, root));
    if (here.length === 0) continue;
    const winner = here.reduce((a, b) => {
      const [sa, sb] = [specificity(a.selector), specificity(b.selector)];
      return outranks(sb, sa) || (!outranks(sa, sb) && b.order > a.order) ? b : a;
    });
    return winner.tokens.get(token);
  }
  return undefined;
}

/** The token a rule of the composition's stylesheet reads for a property. */
const MODULE = cssRules("src/components/builder/export/ExportComposition.module.css");
function reads(selector: string, property: string): string {
  const rule = MODULE.find((r) => r.selector === selector);
  const value = rule && new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`).exec(rule.body)?.[1];
  const tokens = [...new Set([...(value ?? "").matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))];
  expect(tokens, `${selector} ${property}`).toHaveLength(1);
  return tokens[0];
}

/** Dezfil's default credit colours in each theme. */
const LIGHT = { ink: "#5f6f6b", dot: "#93a19c", halo: "#ffffff" };
const DARK = { ink: "#98a3b8", dot: "#5d6880", halo: "#10141d" };

/** The composition as a host mounts it for an image in `appearance` of a map
 * on `key` (null is Auto), and the colours its credit and title are drawn in. */
function drawn(appearance: Appearance, key: BasemapKey | null, custom = false) {
  const host = installDomHost();
  const root = host.document.documentElement;
  if (appearance === "dark") root.setAttribute("data-theme", "dark");
  const react = createRoot(host.document.body as unknown as Element);
  try {
    act(() => react.render(
      <ExportComposition
        width={800}
        height={600}
        outputWidth={1600}
        credit={{ corner: "bottom-right", size: "s" }}
        map={buildCompositionMapInputs({
          definitionBasemapLayers: undefined,
          storedBasemapLayers: null,
          basemapKey: key,
          appearance,
          basemapUrl: "https://tiles.example.test/style.json",
          basemapKind: "vector",
          customBasemap: custom,
          fallbackColor: "#e9ecef",
          layers: [],
          liveFilters: null,
          camera: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 0, bearing: 0 },
        })}
        legend={{ visible: false, corner: "bottom-left", size: "s" }}
        legendLayers={[]}
        widgets={[]}
        values={null}
        valuesState={{ status: "current", error: null }}
        selections={[]}
        title={{ text: "Survey", size: "s" }}
        attribution={[{ label: "© OpenMapTiles", href: "https://openmaptiles.org" }]}
      />,
    ));
    const one = (className: string) => {
      const found = host.document.querySelectorAll(`.${className}`);
      expect(found, className).toHaveLength(1);
      return found[0];
    };
    const credit = one(styles.credit), dot = one(styles.creditDot), title = one(styles.titleChip);
    return {
      credit: {
        ink: resolve(reads(".credit", "color"), credit, root),
        dot: resolve(reads(".creditDot", "color"), dot, root),
        halo: resolve(reads(".credit", "text-shadow"), credit, root),
      },
      titleGround: resolve(reads(".titleChip", "background"), title, root),
    };
  } finally {
    act(() => react.unmount());
    host.uninstall();
  }
}

describe("the image's credit, drawn on the map", () => {
  it("reads against a fixed Light basemap in a dark image as it does in a light one", () => {
    expect(drawn("dark", "light").credit).toEqual(LIGHT);
    expect(drawn("light", "light").credit).toEqual(LIGHT);
  });

  it("reads against a fixed Dark basemap in a light image as it does in a dark one", () => {
    expect(drawn("light", "dark").credit).toEqual(DARK);
    expect(drawn("dark", "dark").credit).toEqual(DARK);
  });

  it("follows the image's theme on Auto, as Auto's basemap does", () => {
    expect(drawn("dark", null).credit).toEqual(DARK);
    expect(drawn("light", null).credit).toEqual(LIGHT);
  });

  it("reads against Streets as against Light, since Streets is a light style in both themes", () => {
    expect(drawn("dark", "streets").credit).toEqual(LIGHT);
    expect(drawn("light", "streets").credit).toEqual(LIGHT);
  });

  it("keeps the image's theme over a style with no tone of its own, a custom one included whatever key it was on", () => {
    expect(drawn("light", "satellite").credit).toEqual(LIGHT);
    expect(drawn("dark", "satellite").credit).toEqual(DARK);
    expect(drawn("dark", "light", true).credit).toEqual(DARK);
    expect(drawn("light", "dark", true).credit).toEqual(LIGHT);
  });

  it("leaves the title, on its own card, in the image's theme", () => {
    expect(drawn("dark", "light").titleGround).toBe(DARK.halo);
    expect(drawn("light", "dark").titleGround).toBe(LIGHT.halo);
  });
});
