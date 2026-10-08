"use client";

import { useEffect, useRef } from "react";
import { useRuleRefusal } from "@/components/use-instance-rules";
import { readApiError } from "../api";

/**
 * Keeps a published map's authored theme equal to the mode its author is
 * composing in.
 *
 * Publishing already captures the composing mode, but nothing updated it
 * afterwards, so flipping light/dark in the builder left the live link in
 * the old mode — which is what made a theme change look like it needed a
 * republish.
 *
 * Two conditions matter. It fires only on a *subsequent* change: the
 * mount value is recorded, not sent, or opening any published map would
 * rewrite its theme to whatever the author happens to be using. And it
 * states only the theme, never the viewer-controls set, so a mode flip
 * cannot re-enable a control the author unchecked.
 *
 * A theme is a change to the publication, so while the instance's rule on
 * who may publish holds the person back the flip sends nothing: the
 * server would refuse it, and the publish popover already says why.
 */
export function usePublishedThemeSync({
  request = fetch,
  mapId,  publishToken,
  theme,
  onFailure,
  onSuccess,
}: {
  request?: typeof fetch;
  mapId: string | null;
  publishToken: string | null | undefined;
  theme: "light" | "dark";
  onFailure: (message: string) => void;
  /** Clears the lane: a standing "it still opens in the previous mode"
   * banner is false the moment a later sync succeeds. */
  onSuccess: () => void;
}): void {
  const lastTheme = useRef(theme);
  // Kept in refs so a caller that rebuilds the callbacks each render does
  // not re-run the sync — the effect must fire on a theme change, nothing
  // else.
  const failureRef = useRef(onFailure);
  const successRef = useRef(onSuccess);
  // Kept in a ref for the same reason: the rule answering must not send.
  const refusal = useRuleRefusal("publishing.publish");
  const heldRef = useRef(refusal !== null);
  useEffect(() => {
    failureRef.current = onFailure;
    successRef.current = onSuccess;
    heldRef.current = refusal !== null;
  }, [onFailure, onSuccess, refusal]);

  useEffect(() => {
    const previous = lastTheme.current;
    lastTheme.current = theme;
    if (previous === theme) return;
    // Not published: the next publication will capture this mode anyway.
    if (!mapId || !publishToken) return;
    if (heldRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await request(`/api/maps/${mapId}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme }),
        });
        if (cancelled) return;
        if (response.ok) successRef.current();
        else failureRef.current(await readApiError(response));
      } catch {
        if (!cancelled) {
          failureRef.current(
            "The published map still opens in the previous mode. Its theme could not be updated.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapId, publishToken, theme, request]);
}
