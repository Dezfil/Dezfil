"use client";

import { useCallback, useRef, type RefObject } from "react";
import type { Viewport } from "@/lib/metadata/maps";

export function useBuilderCamera(
  mapId: string,
  viewportRef: RefObject<Viewport | null>,
  track: <T>(work: Promise<T>) => Promise<T>,
) {
  // The camera keeps its own lane, outside the ordered map queue: it is
  // latest-wins by nature — the newest position is the truth whatever the
  // arrival order — and persisting it must never delay or reorder a real
  // edit. Its response is deliberately never read, so it cannot regress
  // anything. A failed write is the one permitted silent drop: nothing
  // surfaces, and the next movement persists normally. Single-flight
  // makes latest-wins real on the server too: at most one camera write is
  // in the air, and a burst coalesces to the newest position — so arrival
  // order can never settle an older viewport.
  const cameraFlightRef = useRef(false);
  const cameraPendingRef = useRef<Viewport | null>(null);
  const persistViewport = useCallback(
    (v: Viewport) => {
      viewportRef.current = v;
      if (cameraFlightRef.current) {
        // Coalesce, never queue: only the newest position matters.
        cameraPendingRef.current = v;
        return;
      }
      const send = (position: Viewport) => {
        cameraFlightRef.current = true;
        void track(
          fetch(`/api/maps/${mapId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ viewport: position }),
          }),
        )
          .catch(() => {
            // Silent by design — the camera is unrecorded in history and
            // the next gesture repairs it. Handled so it is never an
            // unhandled rejection.
          })
          .finally(() => {
            cameraFlightRef.current = false;
            const pending = cameraPendingRef.current;
            cameraPendingRef.current = null;
            if (pending) send(pending);
          });
      };
      send(v);
    },
    [mapId, track, viewportRef],
  );

  return persistViewport;
}
