import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { LabelStyle, LayerStyle } from "@/lib/style/style";
import { HostElement, installDomHost } from "../../testing/dom-host";
import { LabelToneContext } from "../label-tone";
import { LabelSection } from "./LabelSection";
import { useLabelSetters } from "./use-label-setters";

/**
 * Turning a layer's labels on and off through the Label section, wired to
 * its setters as the style panel wires them: a new label starts following
 * the map for its text and its halo, at size 12, and a label switched off
 * comes back with both its choices and any colours of its own, for the
 * rest of the session.
 */

const RED = { r: 200, g: 40, b: 40, a: 1 };
const SEA = { r: 20, g: 90, b: 120, a: 0.7 };
const LIGHT_TEXT = { r: 36, g: 50, b: 48, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

let layers = 0;

/** The section over its own setters and a style held as the builder holds
 * it, on a fresh layer id each time so no test inherits another's memory. */
function mount(start: LabelStyle | undefined, aggregated = false) {
  const id = `layer-${++layers}`;
  const labels: (LabelStyle | undefined)[] = [];
  function Panel() {
    const [style, setStyle] = useState<Partial<LayerStyle>>({ label: start });
    const patch = (partial: Partial<LayerStyle>) => {
      labels.push(partial.label);
      setStyle((current) => ({ ...current, ...partial }));
    };
    const { setLabelAttribute, setCellLabels } = useLabelSetters(id, style.label, patch);
    return (
      <LabelToneContext.Provider value="dark">
        <LabelSection label={style.label} aggregated={aggregated} tiled={false} stylingFields={[{ name: "name" }, { name: "kind" }]}
          numericFields={[]} count={null} setCellLabels={setCellLabels} setLabelAttribute={setLabelAttribute} patch={patch} />
      </LabelToneContext.Provider>
    );
  }
  const host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  act(() => root.render(<Panel />));
  const props = (element: HostElement) => {
    const key = Object.keys(element).find((k) => k.startsWith("__reactProps$"))!;
    return (element as unknown as Record<string, { onChange: (e: unknown) => void }>)[key];
  };
  const text = (value: string) => act(() => props(container.querySelector('select[aria-label="Label text"]')!).onChange({ target: { value } }));
  const cells = (checked: boolean) => act(() => props(container.querySelector('input[type="checkbox"]')!).onChange({ target: { checked } }));
  const choices = () => [...container.querySelectorAll("[data-paint-choice]")].map((e) => e.getAttribute("data-paint-choice"));
  return { labels, text, cells, choices };
}

describe("a new label", () => {
  it("starts following the map for its text and its halo, at size 12", () => {
    const { labels, text, choices } = mount(undefined);
    text("name");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ attribute: "name", size: 12, textPaint: "automatic", haloPaint: "automatic" });
    expect(choices()).toEqual(["automatic", "automatic", "automatic"]);
  });

  it("on a layer of cells starts the same way when its cells take labels", () => {
    const { labels, cells } = mount(undefined, true);
    cells(true);
    expect(labels[0]).toMatchObject({ size: 12, textPaint: "automatic", haloPaint: "automatic" });
    expect(labels[0]?.attribute).toBeUndefined();
  });
});

describe("labels turned off and on again in the session", () => {
  const ownText: LabelStyle = {
    attribute: "name", size: 18, weight: "bold",
    textPaint: "own", color: RED, haloPaint: "automatic", haloWidth: 1.5, haloColor: WHITE,
  };
  const ownHalo: LabelStyle = {
    attribute: "name", size: 18,
    textPaint: "automatic", color: LIGHT_TEXT, haloPaint: "own", haloWidth: 2.5, haloColor: SEA,
  };

  it.each([["a text of its own", ownText], ["a halo of its own", ownHalo]])("come back with both choices and %s", (_name, label) => {
    const { labels, text, choices } = mount(label);
    const shown = choices();
    text("");
    expect(labels.at(-1)).toBeUndefined();
    text("name");
    expect(labels.at(-1)).toEqual(label);
    expect(choices()).toEqual(shown);
    // A switch of the column keeps them too.
    text("kind");
    expect(labels.at(-1)).toEqual({ ...label, attribute: "kind" });
  });

  it("on a layer of cells, come back with both choices and the colours of their own", () => {
    const cellLabel: LabelStyle = { ...ownHalo, attribute: undefined };
    const { labels, cells } = mount(cellLabel, true);
    cells(false);
    expect(labels.at(-1)).toBeUndefined();
    cells(true);
    expect(labels.at(-1)).toEqual(cellLabel);
  });
});
