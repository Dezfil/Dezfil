import { expect, it } from "vitest";
import { SKETCH_MAX_VERTICES, sketchFeatureError } from "@/lib/sketch/geometry";
import { ICON_SVG_BYTE_CAP, sanitizeSvgIcon } from "@/lib/icon-sanitize";
import { MAX_WIDGETS, MAX_SELECTION_VALUES, isValidSelections } from "@/lib/widgets";
import { isValidFilters, isValidViz } from "@/lib/viz";
import { EXPORT_MAX_DIMENSION, EXPORT_IMAGE_DEFINITION_SCHEMA, definitionRenderProblems, type ExportImageDefinition } from "@/lib/export/image-definition";
import { validateAgainstSchema } from "@/lib/export/schema-validate";
import { FIXTURE_BOUNDS, fixtureBytes, sketchFixture, iconFixture, exportFixture, widgetFixture, extentFixture, renderFixture, viewerFixture } from "../../../scripts/body-fixtures.mjs";
import { boundedBodyText } from "./bounded-body";
it("measures maximal finite fixtures against the shipped validators and byte tiers", async () => {
  expect(FIXTURE_BOUNDS).toEqual({ vertices: SKETCH_MAX_VERTICES, svgBytes: ICON_SVG_BYTE_CAP, widgets: MAX_WIDGETS, values: MAX_SELECTION_VALUES, dimension: EXPORT_MAX_DIMENSION });
  expect(sketchFeatureError(sketchFixture.feature)).toBeNull();
  expect(isValidViz(iconFixture.viz)).toBe(true); expect(sanitizeSvgIcon(iconFixture.viz.customSvg).svg).toHaveLength(ICON_SVG_BYTE_CAP);
  expect(validateAgainstSchema(exportFixture.definition, EXPORT_IMAGE_DEFINITION_SCHEMA)).toEqual([]);
  expect(definitionRenderProblems(exportFixture.definition as ExportImageDefinition)).toEqual([]);
  expect(isValidSelections(widgetFixture.selections)).toBe(true);
  for (const fixture of [renderFixture(16), renderFixture(18), viewerFixture]) expect(isValidFilters(fixture.selections)).toBe(true);
  const fixtures = { sketch: sketchFixture, icon: iconFixture, export: exportFixture, widgets: widgetFixture, extent: extentFixture, render16: renderFixture(16), render18: renderFixture(18), viewer: viewerFixture };
  expect(Object.fromEntries(Object.entries(fixtures).map(([name, value]) => [name, fixtureBytes(value)]))).toEqual({ sketch: 400076, icon: 262201, export: 1500, widgets: 21976, extent: 22055, render16: 61712, render18: 68112, viewer: 58288 });
  for (const [name, value] of Object.entries(fixtures)) {
    const body = JSON.stringify(value), request = new Request("http://instance.test", { method: "POST", body });
    const read = boundedBodyText(request, ["sketch", "icon", "export"].includes(name) ? 16_777_216 : 65_536);
    if (name === "render18") await expect(read).rejects.toMatchObject({ status: 413 });
    else expect(await read).toBe(body);
  }
});
