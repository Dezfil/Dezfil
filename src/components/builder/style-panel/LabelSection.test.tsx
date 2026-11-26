import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { LabelStyle, LayerStyle } from "@/lib/style/style";
import { HostElement, installDomHost } from "../../testing/dom-host";
import { LabelSection } from "./LabelSection";

it("the halo width control runs from no halo to the widest the style accepts", () => {
  const html = renderToStaticMarkup(
    <LabelSection
      label={{ attribute: "name", size: 12, color: { r: 255, g: 255, b: 255, a: 1 }, haloWidth: 3, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } }}
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

/** A label that follows the map: changing a colour or the halo width in
 * the section makes that part the label's own, so the change is kept by the
 * server rather than overridden by the automatic choice beside it. */
describe("a colour changed on a label that follows the map", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
  const automatic: LabelStyle = {
    attribute: "name", size: 12, textPaint: "automatic", haloPaint: "automatic",
    color: { r: 36, g: 50, b: 48, a: 1 }, haloWidth: 1.5, haloColor: { r: 255, g: 255, b: 255, a: 1 },
  };
  function mount(): Partial<LayerStyle>[] {
    const patches: Partial<LayerStyle>[] = [];
    const host = installDomHost();
    const container = host.document.createElement("div");
    host.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
    act(() => root.render(
      <LabelSection label={automatic} aggregated={false} tiled={false} stylingFields={[{ name: "name" }]}
        numericFields={[]} count={null} setCellLabels={() => {}} setLabelAttribute={() => {}}
        patch={(partial) => { patches.push(partial); }} />,
    ));
    const input = (name: string) => {
      const element = container.querySelector(`input[aria-label="${name}"]`) as HostElement;
      const key = Object.keys(element).find((k) => k.startsWith("__reactProps$"))!;
      return (element as unknown as Record<string, { onChange: (e: unknown) => void }>)[key];
    };
    act(() => input("Label color").onChange({ target: { value: "#c82828" } }));
    act(() => input("Label halo color").onChange({ target: { value: "#102030" } }));
    act(() => input("Halo width").onChange({ target: { value: "2" } }));
    return patches;
  }

  it("makes the text its own with the colour, and the halo its own with its colour or width", () => {
    const [color, haloColor, haloWidth] = mount().map((p) => p.label!);
    expect(color).toEqual({ ...automatic, textPaint: "own", color: { r: 200, g: 40, b: 40, a: 1 } });
    expect(haloColor).toEqual({ ...automatic, haloPaint: "own", haloColor: { r: 16, g: 32, b: 48, a: 1 } });
    expect(haloWidth).toEqual({ ...automatic, haloPaint: "own", haloWidth: 2 });
  });
});
