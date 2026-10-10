import {
  RENDER_CHECK_GROUND_COLOR,
  RENDER_CHECK_MARK,
  RENDER_CHECK_MARK_COLOR,
  RENDER_CHECK_SIZE,
  rgb,
} from "@/lib/export/render-check";

/**
 * The image renderer's check picture: a fixed mark on a plain ground,
 * drawn from no one's map or data. It sits behind sign-in like a map's
 * render page, so the renderer reaches it with the render credential; it
 * is ready the moment it is served, and the renderer's Test reads the
 * mark's color back from the image.
 */
export default function RenderCheckPage() {
  return (
    <div
      data-export-root=""
      data-export-ready="true"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: RENDER_CHECK_SIZE.width,
        height: RENDER_CHECK_SIZE.height,
        background: rgb(RENDER_CHECK_GROUND_COLOR),
      }}
    >
      <div
        style={{
          position: "absolute",
          left: RENDER_CHECK_MARK.x,
          top: RENDER_CHECK_MARK.y,
          width: RENDER_CHECK_MARK.width,
          height: RENDER_CHECK_MARK.height,
          background: rgb(RENDER_CHECK_MARK_COLOR),
        }}
      />
    </div>
  );
}
