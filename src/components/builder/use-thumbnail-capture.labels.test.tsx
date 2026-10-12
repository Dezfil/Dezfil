import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS } from "@/lib/basemap";
import { installDomHost } from "../testing/dom-host";
import { useThumbnailCapture, type ThumbnailMapState } from "./use-thumbnail-capture";

/**
 * A map's card image and the label face. Labels and cluster counts are not
 * drawn until the face they draw in has arrived, so a capture taken before
 * it shows the map without its text. Once the face arrives, a map that draws
 * such text is captured once more; a map that draws none is captured
 * exactly as before.
 *
 * The face's readiness is a stand-in this test flips by hand.
 */

const face = vi.hoisted(() => ({ ready: false, listeners: new Set<() => void>() }));
vi.mock("@/components/map/label-font", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    face.listeners.add(listener);
    return () => face.listeners.delete(listener);
  };
  return { useLabelFontReady: () => useSyncExternalStore(subscribe, () => face.ready, () => false) };
});

const theming = { theme: "light" as const, basemapUrl: BASEMAPS[0].url, basemapOverrideUrl: null };
const LABEL = { attribute: "name", size: 12, color: { r: 0, g: 0, b: 0, a: 1 }, haloWidth: 1, haloColor: { r: 255, g: 255, b: 255, a: 1 } };
type Layer = NonNullable<ThumbnailMapState["layers"]>[number];
const layer = (extra: Record<string, unknown>): Layer => ({ id: "l1", sql: "SELECT * FROM stations", visible: true, style: {}, viz: { type: "points" }, ...extra }) as Layer;
const map = (layers: Layer[]): ThumbnailMapState => ({ basemap: "streets", customBasemap: null, basemapLayers: null, layers });

const LABELLED = map([layer({ style: { label: LABEL } })]);
const COUNTED = map([layer({ viz: { type: "cluster", radiusPx: 40, color: "fixed", showCounts: true } })]);
const PLAIN = map([layer({})]);
const HIDDEN_LABELS = map([layer({ style: { label: LABEL }, visible: false })]);
const UNCOUNTED = map([layer({ viz: { type: "cluster", radiusPx: 40, color: "fixed", showCounts: false } })]);

/** The layer renders, held as the builder holds them: one identity until
 * a render lands. */
const RENDERS = {};

function Builder({ state }: { state: ThumbnailMapState }) {
  const handle = useThumbnailCapture("m", state, RENDERS, theming);
  useEffect(() => {
    handle(async () => ({ blob: new Blob(["png"]), paintedStyleUrl: null }) as never);
  }, [handle]);
  return null;
}

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
const fetches = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 204 }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetches);
  fetches.mockClear();
  face.ready = false;
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const open = async (state: ThumbnailMapState) => {
  await act(async () => root.render(<Builder state={state} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
};
const faceArrives = async () => {
  await act(async () => {
    face.ready = true;
    for (const listener of face.listeners) listener();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
};
const uploads = () => fetches.mock.calls.filter(([url]) => String(url).startsWith("/api/maps/m/thumbnail")).length;

describe("a map's card image and the label face", () => {
  it.each([
    ["labels", LABELLED],
    ["cluster counts", COUNTED],
  ])("captures a map with %s once more when the face arrives after its first capture", async (_text, state) => {
    await open(state);
    expect(uploads()).toBe(1);
    await faceArrives();
    expect(uploads()).toBe(2);
  });

  it("captures a labelled map once when the face is there from the start", async () => {
    face.ready = true;
    await open(LABELLED);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(uploads()).toBe(1);
  });

  it.each([
    ["no text at all", PLAIN],
    ["labels only on a hidden layer", HIDDEN_LABELS],
    ["clusters without counts", UNCOUNTED],
  ])("captures a map with %s exactly as before: once, whenever the face arrives", async (_text, state) => {
    await open(state);
    expect(uploads()).toBe(1);
    await faceArrives();
    expect(uploads()).toBe(1);
  });
});
