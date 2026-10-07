// The workflow canvas's and the SQL console's width bands beside the
// person's Side menu pick. Each page's assistant hook is mounted through
// react-dom's client into the stored tree host in ./testing/dom-host, in
// the node environment, with the root carrying the pick as the workspace
// document serves it and the computed `--rail-shift` the look stylesheet
// gives it. No browser: how the pane looks beside the open rail is the
// browser round's.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELPER_OFFSET } from "./builder/helper-bands";
import { useSqlAssistant } from "./sql/SqlAssistantHost";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { useWorkflowAssistant } from "./workflow-canvas/WorkflowAssistantHost";

/** The stylesheet's shift under Always open: 210 px open less 54 px collapsed. */
const SHIFT = 156;

type Rail = "hover" | "open" | "icons";

/** The browser bits the hooks read: the width and its queries, the root's
 * computed shift, the observer the rail's pick is read through, and the
 * frame callback. */
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
      name === "--rail-shift" && element === document.documentElement && element.getAttribute("data-look-rail") === "open" ? `${SHIFT}px` : "0px",
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

function CanvasProbe() {
  const assistant = useWorkflowAssistant(() => {});
  return <b data-probe data-band={assistant.band} />;
}

function ConsoleProbe() {
  const assistant = useSqlAssistant();
  return <button data-probe data-overlay={String(assistant.overlay)} data-offset={String(assistant.offset)} onClick={assistant.toggle}>door</button>;
}

describe("the canvas's and the console's bands follow the open rail", () => {
  let host: ReturnType<typeof installDomHost>;
  let uninstallBits: () => void = () => {};
  let mounted: { container: HostElement; root: ReturnType<typeof createRoot> } | null = null;

  async function mount(node: React.ReactNode, width: number, rail: Rail) {
    if (rail !== "hover") host.document.documentElement.setAttribute("data-look-rail", rail);
    uninstallBits = installBrowserBits(host.window, host.document, width);
    const container = host.document.body.appendChild(host.document.createElement("div"));
    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(node); });
    mounted = { container, root };
    return container.querySelector("[data-probe]")!;
  }

  const canvasBand = async (width: number, rail: Rail) => (await mount(<CanvasProbe />, width, rail)).getAttribute("data-band");
  const consoleOverlay = async (width: number, rail: Rail) => (await mount(<ConsoleProbe />, width, rail)).getAttribute("data-overlay");

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

  describe("the workflow canvas", () => {
    it("keeps one helper's band at 1900 beside the open rail, where the resting rail has both", async () => {
      expect(await canvasBand(1900, "open")).toBe("one");
    });
    it("has both at 1900 under Opens on hover, as today", async () => {
      expect(await canvasBand(1900, "hover")).toBe("both");
    });
    it("has both at 1900 under Icons only, which adds nothing to the chrome", async () => {
      expect(await canvasBand(1900, "icons")).toBe("both");
    });
    it("reaches both at 1860 plus the shift beside the open rail", async () => {
      expect(await canvasBand(1860 + SHIFT, "open")).toBe("both");
    });
    it("overlays at 1200 beside the open rail, where the resting rail docks", async () => {
      expect(await canvasBand(1200, "open")).toBe("overlay");
    });
    it("docks at 1200 beside the resting rail", async () => {
      expect(await canvasBand(1200, "hover")).toBe("one");
    });
    it("docks one past 1120 plus the shift beside the open rail", async () => {
      expect(await canvasBand(1121 + SHIFT, "open")).toBe("one");
    });
  });

  describe("the SQL console", () => {
    it("overlays at 1200 beside the open rail", async () => {
      expect(await consoleOverlay(1200, "open")).toBe("true");
    });
    it("overlays up to 1120 plus the shift beside the open rail", async () => {
      expect(await consoleOverlay(1120 + SHIFT, "open")).toBe("true");
    });
    it("docks past 1120 plus the shift beside the open rail", async () => {
      expect(await consoleOverlay(1121 + SHIFT, "open")).toBe("false");
    });
    it("docks at 1200 under Opens on hover and Icons only, as today", async () => {
      expect(await consoleOverlay(1200, "hover")).toBe("false");
      await act(async () => mounted!.root.unmount());
      host.document.body.removeChild(mounted!.container);
      mounted = null;
      uninstallBits();
      host.uninstall();
      host = installDomHost();
      expect(await consoleOverlay(1200, "icons")).toBe("false");
    });
    it("gives up nothing on the right for the opened pane at 1200 beside the open rail", async () => {
      const door = await mount(<ConsoleProbe />, 1200, "open");
      await act(async () => { door.click(); });
      expect(mounted!.container.querySelector("[data-probe]")!.getAttribute("data-offset")).toBe("0");
    });
    it("gives up the pane's width and gutter for the opened pane at 1200 beside the resting rail", async () => {
      const door = await mount(<ConsoleProbe />, 1200, "hover");
      await act(async () => { door.click(); });
      expect(mounted!.container.querySelector("[data-probe]")!.getAttribute("data-offset")).toBe(String(HELPER_OFFSET));
    });
  });
});
