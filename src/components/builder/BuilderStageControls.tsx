"use client";

import type { Dispatch, SetStateAction } from "react";
import { useLingering } from "../ui/use-lingering";
import { StageButton, StageStack } from "../map/StageStack";
import { DrawDock } from "./draw/DrawDock";
import { DrawPill } from "./draw/DrawPill";
import { DrawOverlay } from "./draw/DrawOverlay";
import { closeDraw, openDraw } from "./draw/draw-mode";
import type { useDrawIntegration } from "./draw/use-draw-integration";
import type { CameraHandle } from "../map/camera-handle";
import type { NoticeTone } from "../use-transient-notice";
import { CompressIcon, ExpandIcon, FitIcon, PencilIcon } from "../ui/icons";
import {
  SAVE_STATUS_EXIT_MS,
  SaveStatusChip,
  SaveStatusCorner,
} from "../ui/SaveStatusChip";
import styles from "./MapBuilder.module.css";

/**
 * The builder's stage furniture: the control stack (shared with the
 * published view) and the draw surface — everything the builder
 * positions over its own map viewport, and the corner the transient
 * status now stands in. The basemap credit belongs to the map it
 * credits and is drawn by `MapPresentation`, right after this.
 *
 * Extracted from MapBuilder at this piece's touch boundary, whole and
 * unchanged: the composition and the placement classes move, the camera
 * handle, the fullscreen state and the draw integration stay where they
 * are and arrive as props. The host owns placement, the components own
 * their boxes — the same division StageStack, BasemapCredit and
 * TimelineBar already keep, and the reason each surface can move its
 * stage edge without the furniture knowing.
 */
export function BuilderStageControls({
  cameraRef,
  bearing,
  pitch,
  onFitAll,
  mapFull,
  onMapFull,
  draw,
  drawCamera,
  saving,
  notice,
}: {
  cameraRef: React.RefObject<CameraHandle | null>;
  bearing: number;
  pitch: number;
  onFitAll: () => void;
  mapFull: boolean;
  onMapFull: Dispatch<SetStateAction<boolean>>;
  draw: ReturnType<typeof useDrawIntegration>;
  drawCamera: CameraHandle | null;
  /** A tracked write is in flight: the count's own
   * indication, which stands until every write settles, failures
   * included, and has no Saved and no retry. */
  saving: boolean;
  /** The four-second notice channel: imports,
   * partial outcomes and failures, skipped members, stopped files,
   * dismissed PostGIS outcomes, source-edit confirmations, and drawing
   * confirmations, refusals and failures. A settled upload carries its
   * tone; a warning or failure reads in the chip's failure tone. */
  notice: string | { text: string; tone: NoticeTone } | null;
}) {
  // The exit the header span had for free, because it kept its literal
  // mounted: the line is marked off the moment the counter settles, and
  // the words stay until the chip has closed on them, so a short write
  // does not flash unreadably. The counter
  // itself is untouched, and an idle chip is still height-zero.
  const savingWords = useLingering(saving, SAVE_STATUS_EXIT_MS);
  return (
    <>
      {/* The stage stack (shared with the published view). Zoom, north
          and tilt come from the component; fit, fullscreen and draw are
          the builder's own — the assistant's door is the top bar's
          since 0115. Fit rides first — directly after tilt — matching
          the published toolbar's placement.

          The anchor is its own element on purpose. The stack's module
          sets position: relative (the basemap panel's anchor) and this
          module sets position: absolute (the canvas placement); on one
          element those are equal-specificity rules from two files, and
          which wins is decided by CSS emission order — which differs
          between the dev server and a production build. A wrapper makes
          the placement order-independent; e2e/stage-anchor.spec.ts holds
          it. */}
      <div className={styles.stageAnchor}>
        <StageStack cameraRef={cameraRef} bearing={bearing} pitch={pitch}>
          <StageButton
            action="Fit to data"
            icon={<FitIcon />}
            onClick={onFitAll}
          />
          <StageButton
            className={styles.fullscreenBtn}
            action={mapFull ? "Exit fullscreen map" : "Fullscreen map"}
            icon={
              <>
                <ExpandIcon className={styles.expand} />
                <CompressIcon className={styles.compress} />
              </>
            }
            aria-pressed={mapFull}
            onClick={() => onMapFull((f) => !f)}
          />
          {/* Draw: last in the stack, builder only — toggling opens the
            dock and starts a session. */}
          <StageButton
            action={draw.mode.open ? "Finish drawing" : "Draw"}
            icon={<PencilIcon />}
            aria-pressed={draw.mode.open}
            data-active={draw.mode.open || undefined}
            onClick={() => (draw.mode.open ? closeDraw() : openDraw())}
          />
        </StageStack>
      </div>
      {/* The stage's top-left overlay corner: ONE chip, and in it a line
          for each of the two channels the builder can have live at once,
          in the order the header spans stood in, each on its own
          lifetime. Neither suppresses the other — choosing between them
          would hide an in-flight save behind a notice's four seconds, or
          spend a notice's whole hold behind a save. */}
      <SaveStatusCorner className={styles.statusCorner} data-save-status-corner>
        <SaveStatusChip
          channels={[
            {
              key: "saving",
              on: saving,
              message: savingWords ? { text: "Saving…" } : null,
            },
            {
              key: "notice",
              message:
                notice === null
                  ? null
                  : typeof notice === "string"
                    ? { text: notice }
                    : { text: notice.text, ...(notice.tone === "ok" ? {} : { tone: "bad" as const }) },
              announce: true,
            },
          ]}
        />
      </SaveStatusCorner>
      {/* The draw surface: overlay beneath, dock and pill above; all
          three read the draw-mode store. */}
      <DrawOverlay
        camera={drawCamera}
        commit={draw.session.commit}
        selectedGeometry={draw.selectedRing}
        onMoveVertex={draw.moveVertex}
      />
      <DrawDock />
      <DrawPill
        committedCount={draw.session.session?.committed.length ?? 0}
        layerName={draw.session.session?.layerName ?? null}
        onDeleteSelected={(sel) => void draw.session.deleteFeature(sel)}
      />
    </>
  );
}
