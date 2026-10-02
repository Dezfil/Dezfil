import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS } from "@/lib/basemap";
import { installDomHost } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import { useThumbnailCapture, type ThumbnailMapState } from "./use-thumbnail-capture";

/**
 * A browser capture of a map's card image is its owner's: the builder an
 * Editor opens on someone else's map takes no image and sends nothing,
 * where the owner's own builder keeps capturing after its edits settle.
 */

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const theming = { theme: "light" as const, basemapUrl: BASEMAPS[0].url, basemapOverrideUrl: null };
const map = (owner: typeof ada | undefined): ThumbnailMapState & { owner?: typeof ada } => ({
  basemap: "streets", customBasemap: null, basemapLayers: null, layers: [], owner,
});

function Builder({ state }: { state: ThumbnailMapState }) {
  const handle = useThumbnailCapture("m", state, {}, theming);
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

const settle = async (who: typeof ada, state: ThumbnailMapState) => {
  await act(async () => root.render(<SignedIn account={who}><Builder state={state} /></SignedIn>));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
};
const uploads = () => fetches.mock.calls.filter(([url]) => String(url).startsWith("/api/maps/m/thumbnail"));

describe("the builder's card capture", () => {
  it("sends the owner's image once the map settles", async () => {
    await settle(ada, map(ada));
    expect(uploads()).toHaveLength(1);
  });

  it("takes nothing on a map someone else owns", async () => {
    await settle(bo, map(ada));
    expect(uploads()).toHaveLength(0);
    expect(fetches).not.toHaveBeenCalled();
  });

  it("keeps capturing when the map's owner is not known", async () => {
    await settle(bo, map(undefined));
    expect(uploads()).toHaveLength(1);
  });
});
