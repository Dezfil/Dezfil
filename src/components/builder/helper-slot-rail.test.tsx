// The builder's helper bands beside the person's Side menu pick. The
// coordinator hook is mounted through react-dom's client into the stored
// tree host in ../testing/dom-host, in the node environment, with the
// root carrying the pick as the workspace document serves it and the
// computed `--rail-shift` the look stylesheet gives it. No browser: how
// the docked helpers look beside the open rail is the browser round's.
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { RecipeDrawer } from "./drawer/RecipeDrawer";
import type { RecipeDrawerState } from "./drawer/use-recipe-drawer";
import { useHelperSlot } from "./use-helper-slot";

/** The stylesheet's shift under Always open: 210 px open less 54 px collapsed. */
const OPEN_SHIFT = "156px";

/** The browser bits the coordinator reads: the width and its queries, the
 * root's computed shift, the observer the rail's pick is read through,
 * and the frame callback. */
function installBrowserBits(window: object, document: { documentElement: HostElement }, width: number) {
  const g = globalThis as Record<string, unknown>;
  const w = window as Record<string, unknown>;
  const kept = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, observer: g.MutationObserver };
  w.innerWidth = width;
  w.matchMedia = (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  };
  // The look stylesheet: the shift is the open width less the collapsed
  // one under Always open, and nothing under the other two picks.
  w.getComputedStyle = (element: HostElement) => ({
    getPropertyValue: (name: string) =>
      name === "--rail-shift" && element === document.documentElement && element.getAttribute("data-look-rail") === "open" ? OPEN_SHIFT : "0px",
  });
  g.MutationObserver = class { observe() {} disconnect() {} };
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0) as unknown as number;
  g.cancelAnimationFrame = (id: number) => { clearTimeout(id as unknown as ReturnType<typeof setTimeout>); };
  return () => {
    g.requestAnimationFrame = kept.raf;
    g.cancelAnimationFrame = kept.caf;
    if (kept.observer === undefined) delete g.MutationObserver; else g.MutationObserver = kept.observer;
  };
}

const SHUT_DRAWER = { open: false, closeReplaced: () => {} } as unknown as RecipeDrawerState;

function Probe() {
  const onToolsOpened = useRef<(() => void) | null>(null);
  const slot = useHelperSlot(SHUT_DRAWER, onToolsOpened);
  return <b data-probe data-band={slot.band} data-overlay={String(slot.overlay)} />;
}

describe("the helper bands follow the open rail", () => {
  let host: ReturnType<typeof installDomHost>;
  let uninstallBits: () => void = () => {};
  let mounted: { container: HostElement; root: ReturnType<typeof createRoot> } | null = null;

  async function bandAt(width: number, rail: "hover" | "open" | "icons") {
    if (rail !== "hover") host.document.documentElement.setAttribute("data-look-rail", rail);
    uninstallBits = installBrowserBits(host.window, host.document, width);
    const container = host.document.body.appendChild(host.document.createElement("div"));
    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(<Probe />); });
    mounted = { container, root };
    const probe = container.querySelector("[data-probe]")!;
    return { band: probe.getAttribute("data-band"), overlay: probe.getAttribute("data-overlay") };
  }

  beforeEach(() => { host = installDomHost(); });
  afterEach(async () => {
    if (mounted) {
      const { root, container } = mounted;
      await act(async () => root.unmount());
      host.document.body.removeChild(container);
      mounted = null;
    }
    uninstallBits();
    host.uninstall();
  });

  it("docks one helper at 1900 beside the open rail, where the resting rail docks both", async () => {
    expect((await bandAt(1900, "open")).band).toBe("one");
  });

  it("docks both at 1900 under the other two picks, as today", async () => {
    expect((await bandAt(1900, "hover")).band).toBe("both");
  });

  it("docks both under Icons only, which adds nothing to the chrome", async () => {
    expect((await bandAt(1900, "icons")).band).toBe("both");
  });

  it("overlays at 1200 beside the open rail, where the resting rail docks", async () => {
    expect(await bandAt(1200, "open")).toEqual({ band: "overlay", overlay: "true" });
  });

  it("docks at 1200 beside the resting rail", async () => {
    expect(await bandAt(1200, "hover")).toEqual({ band: "one", overlay: "false" });
  });

  it("raises the Tools drawer over the stage exactly when the slot says it overlays", async () => {
    uninstallBits = installBrowserBits(host.window, host.document, 1200);
    for (const overlay of [true, false]) {
      const container = host.document.body.appendChild(host.document.createElement("div"));
      const root = createRoot(container as unknown as Element);
      const state = { open: true, width: 342, close: () => {} } as unknown as RecipeDrawerState;
      await act(async () => { root.render(<RecipeDrawer state={state} name="Tools" onDismiss={() => {}} overlay={overlay} />); });
      expect(container.querySelector("[data-recipe-drawer]")!.getAttribute("data-overlay"), String(overlay)).toBe(String(overlay));
      await act(async () => root.unmount());
      host.document.body.removeChild(container);
    }
  });
});
