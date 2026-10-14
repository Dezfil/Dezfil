import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
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
