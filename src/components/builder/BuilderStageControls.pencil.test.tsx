import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BuilderStageControls } from "./BuilderStageControls";
import type { CameraHandle } from "../map/camera-handle";

/**
 * The pencil and the map's camera. The stage controls show before the map
 * canvas has loaded, and the draw overlay places a shape through the
 * camera: with none, every click of a drawing was dropped and the shape
 * never saved. So a session cannot start until the camera exists.
 */
type Props = Parameters<typeof BuilderStageControls>[0];
const camera = {} as CameraHandle;
const drawWith = (open: boolean) =>
  ({
    mode: { open, tool: null, selected: null },
    session: { session: null, commit: async () => {}, deleteFeature: async () => {} },
    selectedRing: null,
    moveVertex: () => {},
  }) as unknown as Props["draw"];

/** The draw control's opening tag, as rendered. */
function pencil(open: boolean, drawCamera: CameraHandle | null): string {
  const html = renderToStaticMarkup(
    <BuilderStageControls cameraRef={{ current: null }} bearing={0} pitch={0} onFitAll={() => {}}
      mapFull={false} onMapFull={() => {}} drawCamera={drawCamera} draw={drawWith(open)}
      saving={false} notice={null} />,
  );
  const tag = html.match(/<button[^>]*aria-label="(?:Draw|Finish drawing)"[^>]*>/)?.[0];
  expect(tag, "the draw control is rendered").toBeDefined();
  return tag!;
}

it("holds the pencil until the map has a camera to place a shape with", () => {
  expect(pencil(false, null)).toMatch(/\sdisabled=""/);
  expect(pencil(false, camera)).not.toMatch(/\sdisabled/);
});

it("never holds Finish drawing: an open session can always be closed", () => {
  expect(pencil(true, null)).not.toMatch(/\sdisabled/);
  expect(pencil(true, camera)).not.toMatch(/\sdisabled/);
});
