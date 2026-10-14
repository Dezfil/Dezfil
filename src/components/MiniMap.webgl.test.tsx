import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { INITIAL_WEBGL_FAILURE_MESSAGE } from "./map/initial-webgl-failure";
import { installDomHost } from "./testing/dom-host";

/**
 * A browser that offers no WebGL2: the mini map's renderer refuses to
 * start. The mini map says so in its own place, and the pane around it
 * (and so the dialog and the page) keeps working.
 */

// The pane's mini map, loaded as the browser would load it.
vi.mock("next/dynamic", async () => {
  const { MiniMap } = await import("./MiniMap");
  return { default: () => MiniMap };
});
vi.mock("@/lib/maplibre", async (original) => {
  const real = await original<typeof import("@/lib/maplibre")>();
  return {
    ...real,
    Map: class {
      constructor() {
        throw new real.GPUInitializationError({}, null);
      }
    },
  };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

it("a mini map whose renderer cannot start says so, and the pane around it stays", async () => {
  const host = installDomHost();
  // Every request the pane and the mini map make stays pending.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const { OverturePane } = await import("./OverturePane");
  const root = createRoot(host.document.body as unknown as Element);
  cleanups.push(() => {
    act(() => root.unmount());
    host.uninstall();
  });
  await act(async () => root.render(<OverturePane onTableCreated={() => {}} />));
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  const notes = host.document.querySelectorAll('[role="alert"]').map((n) => n.textContent);
  expect(notes).toEqual([`WebGL is unavailable${INITIAL_WEBGL_FAILURE_MESSAGE}`]);
  // The rest of the pane: its release picker and its import action.
  expect(host.document.getElementById("ovt-release")).not.toBeNull();
  expect(host.document.querySelectorAll("button").some((b) => b.textContent === "Run Query")).toBe(true);
});
