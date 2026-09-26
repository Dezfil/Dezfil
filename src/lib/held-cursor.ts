/**
 * A held view over the status channel for the published cursor readout.
 * The attribution strip is a DOM sibling of the canvas, so reaching for
 * the readout fires the map's own mouseout and the cursor nulls just
 * before a click could land. This store keeps the last cursor-bearing
 * status alive through a short hold, extended while the pointer is on
 * the readout, so copy-on-click is physically possible.
 *
 * The channel subscription lives inside attach(), NOT in the factory:
 * attach is written for useSyncExternalStore, whose Strict-Mode remount
 * runs cleanup and subscribes again — a subscription made in the factory
 * would be severed by that cleanup and never remade (found live by the
 * PR #67 clipboard round: the readout never mounted under next dev).
 */

import type { MapStatus, StatusChannel } from "./map-status";

export interface HeldCursor {
  /** Connect the React layer: joins the channel on first attach, relays
   * store changes, and the returned cleanup severs both — re-callable,
   * as Strict Mode requires. */
  attach(onChange: () => void): () => void;
  /** The last cursor-bearing status, or null once the hold has lapsed. */
  get(): MapStatus | null;
  /** The pointer is on the readout: entering extends the hold until it
   * leaves; leaving with no live cursor clears immediately. */
  setHovered(hovered: boolean): void;
}

export const HOLD_MS = 250;

export function createHeldCursor(
  channel: StatusChannel,
  holdMs: number = HOLD_MS,
): HeldCursor {
  let held: MapStatus | null = null;
  let hovered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let channelUnsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const clear = () => {
    if (held !== null) {
      held = null;
      notify();
    }
  };
  const onChannel = () => {
    const status = channel.get();
    clearTimeout(timer);
    if (status?.cursor) {
      held = status;
      notify();
      return;
    }
    timer = setTimeout(() => {
      if (!hovered) clear();
    }, holdMs);
  };
  return {
    attach(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) {
        channelUnsubscribe = channel.subscribe(onChannel);
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          channelUnsubscribe?.();
          channelUnsubscribe = undefined;
          clearTimeout(timer);
          held = null;
        }
      };
    },
    get: () => held,
    setHovered(next) {
      hovered = next;
      if (!next && !channel.get()?.cursor) clear();
    },
  };
}
