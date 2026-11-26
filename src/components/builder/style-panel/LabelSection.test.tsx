import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { LabelStyle, LayerStyle } from "@/lib/style/style";
import type { LabelTone } from "@/lib/style/label-recipe";
import { HostElement, installDomHost } from "../../testing/dom-host";
import { LabelToneContext } from "../label-tone";
import { LabelSection } from "./LabelSection";

it("the halo width control runs from no halo to the widest the style accepts", () => {
  const html = renderToStaticMarkup(
    <LabelSection
      label={{ attribute: "name", size: 12, textPaint: "own", color: { r: 255, g: 255, b: 255, a: 1 }, haloPaint: "own", haloWidth: 3, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } }}
      aggregated={false}
      tiled={false}
      stylingFields={[{ name: "name" }]}
      numericFields={[]}
      count={null}
      setCellLabels={() => {}}
      setLabelAttribute={() => {}}
      patch={() => {}}
    />,
  );
  const halo = html.match(/<input[^>]*aria-label="Halo width"[^>]*>/)?.[0] ?? "";
  expect(halo).toContain('min="0"');
  expect(halo).toContain('max="3"');
  expect(halo).toContain('value="3"');
});

// The two recipes and the colours below are written out here, not read
// from the code under test.
const LIGHT_TEXT = { r: 36, g: 50, b: 48, a: 1 }; // #243230
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const DARK_HALO = { r: 11, g: 14, b: 20, a: 1 }; // #0b0e14
const RED = { r: 200, g: 40, b: 40, a: 1 }; // #c82828
const NAVY = { r: 16, g: 32, b: 48, a: 1 }; // #102030
const SEA = { r: 20, g: 90, b: 120, a: 0.7 };

/** A label that follows the map, as a map on an Auto basemap stores it:
 * the light fallbacks beside its two choices. */
const automatic: LabelStyle = {
  attribute: "name", size: 12,
  textPaint: "automatic", color: LIGHT_TEXT,
  haloPaint: "automatic", haloWidth: 1.5, haloColor: WHITE,
};
/** A label whose text and halo are both its own. */
const own: LabelStyle = {
  attribute: "name", size: 12,
  textPaint: "own", color: RED,
  haloPaint: "own", haloWidth: 2.5, haloColor: SEA,
};

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

/** React's own handlers on a mounted element, as the browser would call them. */
function handlers(element: HostElement): Record<string, (e: unknown) => unknown> {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (e: unknown) => unknown>>)[key];
}

/** The section mounted under the tone the builder hands down, every
 * patch, preview and commit it sends kept in order. */
function mount(label: LabelStyle, tone: LabelTone, split = false) {
  const patches: Partial<LayerStyle>[] = [];
  const previews: Partial<LayerStyle>[] = [];
  const commits: Partial<LayerStyle>[] = [];
  const host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  act(() => root.render(
    <LabelToneContext.Provider value={tone}>
      <LabelSection label={label} aggregated={false} tiled={false} stylingFields={[{ name: "name" }]}
        numericFields={[]} count={null} setCellLabels={() => {}} setLabelAttribute={() => {}}
        patch={(partial) => { patches.push(partial); }}
        {...(split ? {
          onStylePreview: (partial: Partial<LayerStyle>) => { previews.push(partial); },
          onStyleCommit: async (partial: Partial<LayerStyle>) => { commits.push(partial); return true; },
        } : {})} />
    </LabelToneContext.Provider>,
  ));
  const input = (name: string) => {
    const element = container.querySelector(`input[aria-label="${name}"]`) as HostElement | null;
    expect(element, name).not.toBeNull();
    return element!;
  };
  /** What a row says of its part: "Automatic" as a word while it follows
   * the map, a way back while it is the label's own. */
  const choice = (name: string) => {
    const row = input(name).parentNode as HostElement;
    const shown = row.querySelector("[data-paint-choice]");
    return shown && { state: shown.getAttribute("data-paint-choice"), tag: shown.tagName, text: shown.textContent, name: shown.getAttribute("aria-label") };
  };
  const back = (name: string) => {
    const row = input(name).parentNode as HostElement;
    const button = row.querySelector('button[data-paint-choice="own"]');
    expect(button, `${name}: the way back`).not.toBeNull();
    act(() => button!.click());
  };
  const change = (name: string, value: string) => act(() => { handlers(input(name)).onChange({ target: { value } }); });
  return { patches, previews, commits, input, choice, back, change, handlers };
}

const FOLLOWS = { state: "automatic", tag: "SPAN", text: "Automatic", name: null };

describe("the paint rows of a label that follows the map", () => {
  it.each<[LabelTone, string, string]>([
    ["light", "#243230", "#ffffff"],
    ["dark", "#e9ecf3", "#0b0e14"],
  ])("say Automatic and show the paint the map draws over a %s basemap", (tone, text, halo) => {
    // Stored with the light fallbacks either way: the rows show the tone's paint.
    const { input, choice } = mount(automatic, tone);
    expect(input("Label color").value).toBe(text);
    expect(input("Halo width").value).toBe("1.5");
    expect(input("Label halo color").value).toBe(halo);
    for (const row of ["Label color", "Halo width", "Label halo color"]) expect(choice(row), row).toEqual(FOLLOWS);
  });

  it("show a text of the label's own with its colour and a way back, the halo still following", () => {
    const { input, choice } = mount({ ...automatic, textPaint: "own", color: RED }, "dark");
    expect(input("Label color").value).toBe("#c82828");
    expect(choice("Label color")).toEqual({ state: "own", tag: "BUTTON", text: "Automatic", name: "Label color back to Automatic" });
    expect(input("Label halo color").value).toBe("#0b0e14");
    expect(choice("Halo width")).toEqual(FOLLOWS);
    expect(choice("Label halo color")).toEqual(FOLLOWS);
  });

  it("show a halo of the label's own with its width and colour and a way back on each halo row, the text still following", () => {
    const { input, choice } = mount({ ...automatic, haloPaint: "own", haloWidth: 2.5, haloColor: SEA }, "dark");
    expect(input("Label color").value).toBe("#e9ecf3");
    expect(choice("Label color")).toEqual(FOLLOWS);
    expect(input("Halo width").value).toBe("2.5");
    expect(input("Label halo color").value).toBe("#145a78");
    expect(choice("Halo width")).toEqual({ state: "own", tag: "BUTTON", text: "Automatic", name: "Halo width back to Automatic" });
    expect(choice("Label halo color")).toEqual({ state: "own", tag: "BUTTON", text: "Automatic", name: "Label halo color back to Automatic" });
  });
});

describe("a change in the paint rows makes only its own part the label's own", () => {
  it("a text colour makes the text its own and leaves the halo as it is", () => {
    const { patches, change } = mount(automatic, "dark");
    change("Label color", "#c82828");
    expect(patches.map((p) => p.label)).toEqual([{ ...automatic, textPaint: "own", color: RED }]);
  });

  it("a halo width makes the whole halo its own, its colour starting from the one shown over a dark map", () => {
    // The stored fallback is white; the row showed the dark recipe's rim.
    const { patches, change } = mount(automatic, "dark");
    change("Halo width", "2");
    expect(patches.map((p) => p.label)).toEqual([{ ...automatic, haloPaint: "own", haloWidth: 2, haloColor: DARK_HALO }]);
  });

  it("a halo colour makes the whole halo its own, its width starting from the one shown", () => {
    // Just taken back to Automatic: the label still carries its old width
    // until the server answers with the fallbacks, and the row shows 1.5.
    const { patches, change } = mount({ ...automatic, haloWidth: 2.5, haloColor: SEA }, "dark");
    change("Label halo color", "#102030");
    expect(patches.map((p) => p.label)).toEqual([{ ...automatic, haloPaint: "own", haloWidth: 1.5, haloColor: NAVY }]);
  });

  it("a halo width dragged previews and commits the same captured pair", async () => {
    const { previews, commits, patches, input, handlers } = mount(automatic, "dark", true);
    const slider = handlers(input("Halo width"));
    act(() => { slider.onPointerDown({}); slider.onChange({ target: { value: "2" } }); });
    await act(async () => { await slider.onPointerUp({}); });
    const expected = { ...automatic, haloPaint: "own", haloWidth: 2, haloColor: DARK_HALO };
    expect(previews.map((p) => p.label)).toEqual([expected]);
    expect(commits.map((p) => p.label)).toEqual([expected]);
    expect(patches).toEqual([]);
  });

  it("a change to a part already its own keeps the other part's own colours", () => {
    const { patches, change } = mount(own, "dark");
    change("Label halo color", "#102030");
    change("Label color", "#243230");
    expect(patches.map((p) => p.label)).toEqual([
      { ...own, haloColor: { ...NAVY, a: SEA.a } },
      { ...own, color: LIGHT_TEXT },
    ]);
  });
});

describe("Automatic takes back only its own part", () => {
  it("on the Color row, the text, leaving a halo of the label's own as it is", () => {
    const { patches, back } = mount(own, "dark");
    back("Label color");
    expect(patches.map((p) => p.label)).toEqual([{ ...own, textPaint: "automatic" }]);
  });

  it.each(["Halo width", "Label halo color"])("on the %s row, the halo's width and colour together, leaving a text of the label's own as it is", (row) => {
    const { patches, back } = mount(own, "dark");
    back(row);
    expect(patches.map((p) => p.label)).toEqual([{ ...own, haloPaint: "automatic" }]);
  });
});
