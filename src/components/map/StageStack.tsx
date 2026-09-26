"use client";

import type { ReactNode, Ref } from "react";
import { IconButton } from "../ui/IconButton";
import {
  CompassNeedleIcon,
  MinusIcon,
  PlusIcon,
  TiltIcon,
} from "../ui/icons";
import type { CameraHandle } from "./camera-handle";
import styles from "./StageStack.module.css";

/**
 * A button in the stage stack's box. Exported so each surface can compose
 * its own entries — the builder's fullscreen and assistant, the viewer's
 * fit, theme and basemap — without the stack having to know about them.
 */
export function StageButton({
  ref,
  className,
  ...rest
}: React.ComponentProps<typeof IconButton> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <IconButton
      ref={ref}
      tone="chrome"
      // The one styled tooltip: stage buttons drop the native title for
      // the shared treatment, builder and published alike.
      hint
      className={className ? `${styles.stageBtn} ${className}` : styles.stageBtn}
      {...rest}
    />
  );
}

/**
 * The map's control stack (shared by the builder and the published view).
 * It holds the camera controls both surfaces need — zoom, point north,
 * tilt — and takes everything else as children, so neither surface's
 * extras leak into the other.
 *
 * Zoom and point north are always rendered: a map a reader cannot
 * navigate or straighten reads as broken, which is why does not let an
 * author remove them. Tilt is optional because a published map may
 * legitimately be flat-only.
 *
 * The camera arrives as a ref, not as callbacks: the canvas hands its
 * handle over once on mount and nulls it on teardown, and both hosts
 * already hold that ref for their other camera consumers.
 */
export function StageStack({
  cameraRef,
  bearing,
  pitch,
  tilt = true,
  className,
  children,
}: {
  cameraRef: React.RefObject<CameraHandle | null>;
  /** The view's bearing in degrees — the needle counter-rotates by it. */
  bearing: number;
  /** The view's pitch in degrees — drives the tilt toggle's state. */
  pitch: number;
  tilt?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={
        className ? `${styles.stageStack} ${className}` : styles.stageStack
      }
    >
      <StageButton
        action="Zoom in"
        icon={<PlusIcon />}
        onClick={() => cameraRef.current?.zoomIn()}
      />
      <StageButton
        action="Zoom out"
        icon={<MinusIcon />}
        onClick={() => cameraRef.current?.zoomOut()}
      />
      <StageButton
        className={styles.compassBtn}
        action="Point north"
        icon={<CompassNeedleIcon bearing={bearing} />}
        onClick={() => cameraRef.current?.resetNorth()}
      />
      {tilt && (
        <StageButton
          action={pitch > 0 ? "Back to flat" : "Tilt the map"}
          icon={<TiltIcon />}
          aria-pressed={pitch > 0}
          data-active={pitch > 0 || undefined}
          onClick={() => cameraRef.current?.setPitch(pitch > 0 ? 0 : 55)}
        />
      )}
      {children}
    </div>
  );
}
