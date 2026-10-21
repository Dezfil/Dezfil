import { existsSync, readdirSync, readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TemplateSource } from "@/lib/templates/format";
import { creditInFull } from "../templates/template-model";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { AppearancePreview, PREVIEW_CREDIT, PREVIEW_TEMPLATE, previewPicture } from "./AppearancePreview";
import styles from "./AppearancePreview.module.css";

/**
 * Appearance's preview: a small builder over a shipped template's picture,
 * each piece drawn by its own surface role and nothing else, so it shows
 * every pick and the theme as the builder does; its own card solid, in
 * sight under the page's top band as the cards scroll, and in the flow on
 * one column.
 */

const SHEET = readFileSync("src/components/settings/AppearancePreview.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** A rule's declarations, by its selector, inside the at-rule named or at the top. */
function rule(selector: string, within: string | null = null): Map<string, string> {
  let text = SHEET;
  if (within) {
    const at = SHEET.indexOf(`${within} {`);
    expect(at, within).toBeGreaterThan(-1);
    text = SHEET.slice(at + within.length + 2);
  }
  const head = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(text);
  return new Map([...(head?.[2] ?? "").matchAll(/([-\w]+)\s*:\s*([^;]+);/g)].map(([, property, value]) => [property, value.trim().replace(/\s+/g, " ")]));
}

/** Each piece of the builder and the surface role it plays. */
const PIECES: [piece: string, role: string][] = [
  ["chrome", "glass-chrome"], ["panel", "glass-panel"], ["inner", "inner-card"], ["mapCard", "map-card"],
  ["overlay", "overlay-panel"], ["control", "overlay-control"],
];

describe("the Appearance preview", () => {
  it("draws the header, the side menu, the inspector and its layers, the map buttons, two widget cards and the legend over the template's picture", () => {
    const html = renderToStaticMarkup(<AppearancePreview />);
    expect(html).toMatch(/<figure[^>]*data-appearance-preview=""/);
    expect(html).toMatch(/<figcaption[^>]*><span>Preview<\/span><small>OpenFlights.org \(ODbL-1.0\)<\/small><\/figcaption>/);
    expect(html).toContain(`src="${previewPicture("light")}"`);
    expect(previewPicture("dark")).toBe("/api/templates/air-routes/picture?theme=dark");
    for (const words of ["The world&#x27;s air routes", "Publish", "Layers", "Airports", "Air routes, June 2014", "Airport pairs", "Haul, by distance", "busier airport"]) {
      expect(html, words).toContain(words);
    }
    // The scene is a picture of the builder: nothing in it is read out.
    expect(html).toMatch(/<\/figcaption><div[^>]*aria-hidden="true"/);
  });

  it("gives each piece its role and has every role's look read from its tokens alone", () => {
    const html = renderToStaticMarkup(<AppearancePreview />);
    const count = (piece: string) => html.split(/class="/).slice(1).filter(attribute => attribute.split('"')[0].split(" ").includes(styles[piece])).length;
    // The header, the header's two buttons and the side menu; the inspector; its two layers; the two widget cards;
    // the legend; the two map buttons.
    expect(PIECES.map(([piece]) => count(piece))).toEqual([4, 1, 2, 2, 1, 2]);
    // Each piece names what it is, so a reader finds it without the stylesheet's names.
    const named = [...html.matchAll(/data-piece="([\w-]+)"/g)].map(([, piece]) => piece);
    expect(named).toEqual(["header", "header-button", "header-button", "side-menu", "inspector", "layer", "layer", "map-button", "map-button", "widget", "widget", "legend"]);
    for (const [piece, role] of PIECES) {
      const own = rule(`.${piece}`);
      const wanted = new Map(["edge", "fill", "blur", "shadow"].map(part => [
        { edge: "border", fill: "background", blur: "backdrop-filter", shadow: "box-shadow" }[part]!, `var(--surface-${role}-${part})`]));
      expect(own, piece).toEqual(wanted);
    }
  });

  it("credits the template's data as its card does, from the template shipped with Dezfil", () => {
    const shipped = readdirSync(`templates/${PREVIEW_TEMPLATE}`).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))[0];
    const template = JSON.parse(readFileSync(`templates/${PREVIEW_TEMPLATE}/${shipped}/template.json`, "utf8")) as { sources: TemplateSource[] };
    expect(PREVIEW_CREDIT).toBe(creditInFull(template.sources));
    expect(existsSync(`templates/${PREVIEW_TEMPLATE}/${shipped}/pictures/light.png`) && existsSync(`templates/${PREVIEW_TEMPLATE}/${shipped}/pictures/dark.png`)).toBe(true);
  });

  it("stands on a solid card, in sight under the page's top band, and in the flow on one column", () => {
    const card = rule(".preview");
    expect(card.get("background")).toBe("var(--bg-panel)");
    expect(card.get("position")).toBe("sticky");
    expect(card.get("top")).toBe("58px");
    expect(rule(".preview", "@media (max-width: 900px)").get("position")).toBe("static");
    // The picture keeps its lower right, where the basemap's credit is, in view.
    expect(rule(".map").get("object-position")).toBe("100% 100%");
    // What the page scrolls to lands clear of the Preview while it stands over the column, and not on one column.
    expect(rule(":global(:root):has(.preview)").get("scroll-padding-top")).toBe("286px");
    expect(rule(":global(:root):has(.preview)", "@media (max-width: 900px)").get("scroll-padding-top")).toBe("0");
    expect(rule(".scene").get("background")).toBe("var(--bg)");
  });
});

describe("the Appearance preview without its picture", () => {
  let host: ReturnType<typeof installDomHost>;
  let root: ReturnType<typeof createRoot>;
  let container: HostElement;
  beforeEach(() => {
    host = installDomHost();
    container = host.document.createElement("div");
    host.document.body.appendChild(container);
    root = createRoot(container as unknown as Element);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.uninstall();
  });

  it("drops the picture that does not load and keeps every piece on the page's ground", async () => {
    await act(async () => root.render(<AppearancePreview />));
    const picture = container.querySelector("img")!;
    expect(picture.getAttribute("src")).toBe(previewPicture("light"));
    await act(async () => { picture.dispatchEvent(new HostEvent("error")); });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Air routes, June 2014");
  });
});
