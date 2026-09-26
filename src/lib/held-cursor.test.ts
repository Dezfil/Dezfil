import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStatusChannel, type MapStatus } from "./map-status";
import { createHeldCursor, HOLD_MS } from "./held-cursor";
import type { Bounds } from "./geo-bounds";

const bounds: Bounds = [
  [8, 50],
  [9, 51],
];
const at = (lng: number, lat: number): MapStatus => ({
  cursor: { lng, lat },
  zoom: 10,
  bounds,
});
const offMap: MapStatus = { cursor: null, zoom: 10, bounds };

describe("held cursor store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes cursor-bearing statuses through and notifies", () => {
    const channel = createStatusChannel();
    const store = createHeldCursor(channel);
    const seen = vi.fn();
    const detach = store.attach(seen);
    channel.emit(at(8.5, 50.5));
    expect(store.get()?.cursor).toEqual({ lng: 8.5, lat: 50.5 });
    expect(seen).toHaveBeenCalledTimes(1);
    detach();
  });

  it("survives the Strict-Mode remount: attach, cleanup, attach again", () => {
    // The regression the PR #67 clipboard round found live: a factory
    // subscription severed by the double-mount's cleanup was never
    // remade, and the readout never appeared under next dev. Red-proven
    // against that shape; the subscription now lives in attach().
    const channel = createStatusChannel();
    const store = createHeldCursor(channel);
    const first = store.attach(vi.fn());
    first();
    const seen = vi.fn();
    const detach = store.attach(seen);
    channel.emit(at(8.5, 50.5));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.get()?.cursor).toEqual({ lng: 8.5, lat: 50.5 });
    detach();
  });

  it("holds the last reading through the grace, then clears", () => {
    const channel = createStatusChannel();
    const store = createHeldCursor(channel);
    const detach = store.attach(vi.fn());
    channel.emit(at(8.5, 50.5));
    channel.emit(offMap);
    // Still held inside the grace window — the click can land here.
    expect(store.get()?.cursor).toEqual({ lng: 8.5, lat: 50.5 });
    vi.advanceTimersByTime(HOLD_MS + 1);
    expect(store.get()).toBeNull();
    detach();
  });

  it("extends the hold while hovered and clears on leave", () => {
    const channel = createStatusChannel();
    const store = createHeldCursor(channel);
    const detach = store.attach(vi.fn());
    channel.emit(at(8.5, 50.5));
    channel.emit(offMap);
    store.setHovered(true);
    vi.advanceTimersByTime(HOLD_MS * 10);
    // Hovering the readout keeps it alive indefinitely.
    expect(store.get()?.cursor).toEqual({ lng: 8.5, lat: 50.5 });
    store.setHovered(false);
    // Leaving with no live cursor clears without waiting for a timer.
    expect(store.get()).toBeNull();
    detach();
  });

  it("a returning cursor cancels the pending clear", () => {
    const channel = createStatusChannel();
    const store = createHeldCursor(channel);
    const detach = store.attach(vi.fn());
    channel.emit(at(8.5, 50.5));
    channel.emit(offMap);
    channel.emit(at(9, 51));
    vi.advanceTimersByTime(HOLD_MS * 10);
    expect(store.get()?.cursor).toEqual({ lng: 9, lat: 51 });
    detach();
  });

  it("leaving the readout back onto the map keeps the live reading", () => {
    const channel = createStatusChannel();
    const store = createHeldCursor(channel);
    const detach = store.attach(vi.fn());
    channel.emit(at(8.5, 50.5));
    store.setHovered(true);
    store.setHovered(false);
    // The channel still holds a live cursor, so nothing clears.
    expect(store.get()?.cursor).toEqual({ lng: 8.5, lat: 50.5 });
    detach();
  });

  it("the last detach severs the channel and resets the held state", () => {
    const channel = createStatusChannel();
    const store = createHeldCursor(channel);
    const seen = vi.fn();
    const detach = store.attach(seen);
    channel.emit(at(8.5, 50.5));
    detach();
    channel.emit(at(9, 51));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.get()).toBeNull();
  });
});
