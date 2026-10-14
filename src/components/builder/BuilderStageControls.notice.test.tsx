import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BuilderStageControls } from "./BuilderStageControls";

type Props = Parameters<typeof BuilderStageControls>[0];
const draw = {
  mode: { open: false, tool: null, selected: null },
  session: { session: null, commit: async () => {}, deleteFeature: async () => {} },
  selectedRing: null,
  moveVertex: () => {},
} as unknown as Props["draw"];

/** The notice line of the stage's chip, as rendered. */
function noticeLine(notice: Props["notice"]): string {
  const html = renderToStaticMarkup(
    <BuilderStageControls cameraRef={{ current: null }} bearing={0} pitch={0} onFitAll={() => {}}
      mapFull={false} onMapFull={() => {}} drawCamera={null} draw={draw} saving={false} notice={notice} />,
  );
  return html.match(/<span[^>]*data-save-status="notice"[^>]*>/)?.[0] ?? "";
}

it("draws a failed or partly failed upload's notice in the chip's failure tone, and a whole one plainly", () => {
  expect(noticeLine({ text: "roads.csv could not be imported", tone: "danger" })).toContain('data-tone="bad"');
  expect(noticeLine({ text: "Added wells to this map · roads.csv could not be imported", tone: "warn" })).toContain('data-tone="bad"');
  expect(noticeLine({ text: "Added wells to this map", tone: "ok" })).not.toContain("data-tone");
  expect(noticeLine("Updated wells · 12 ms")).not.toContain("data-tone");
});
