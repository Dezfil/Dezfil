// The assistant pane starts closed on every page open, whatever the
// page, and is opened by a click on its door. The three hosts'
// hooks — the builder's helper slot, the /sql console and the workflow
// canvas — are mounted through react-dom's client into the stored-tree
// host in ../../testing/dom-host, in the node environment: no browser,
// no DOM library.
//
// A storage that really remembers is installed with the tree, and the
// memory's key is written before the mount that must ignore it. Without
// it the old preference store's read throws and answers false, and the
// behaviour under test — a pane opened once coming back open on the
// next page and the next reload — could not be reproduced at all, so
// the red would be no red.
import { act, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDomHost, type HostElement } from "../../testing/dom-host";
import type { RecipeDrawerState } from "../drawer/use-recipe-drawer";
import { useHelperSlot } from "../use-helper-slot";
import { useSqlAssistant } from "../../sql/SqlAssistantHost";
import { useWorkflowAssistant } from "../../workflow-canvas/WorkflowAssistantHost";

/** The per-browser key the open state used to live under. */
const MEMORY_KEY = "dezfil-assistant-open";
/** A width in the one-docked band: no overlay, no three-pane rule. */
const WIDTH = 1440;

/** The browser bits the three hooks read that the stored tree has no
 * opinion about: the width queries, the frame callback, a storage, and
 * the observer the builder's slot reads the rail's pick through. */
function installBrowserBits(window: object) {
  const g = globalThis as Record<string, unknown>;
  const w = window as Record<string, unknown>;
  const kept = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, storage: g.localStorage, observer: g.MutationObserver };
  const cells = new Map<string, string>();
  const storage = {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => { cells.set(key, value); },
    removeItem: (key: string) => { cells.delete(key); },
    clear: () => cells.clear(),
  };
  w.innerWidth = WIDTH;
  w.matchMedia = (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? WIDTH <= Number(max[1]) : min ? WIDTH >= Number(min[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  };
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0) as unknown as number;
  g.cancelAnimationFrame = (id: number) => { clearTimeout(id as unknown as ReturnType<typeof setTimeout>); };
  g.localStorage = storage;
  g.MutationObserver = class { observe() {} disconnect() {} };
  return {
    storage,
    uninstall() {
      g.requestAnimationFrame = kept.raf;
      g.cancelAnimationFrame = kept.caf;
      if (kept.storage === undefined) delete g.localStorage; else g.localStorage = kept.storage;
      if (kept.observer === undefined) delete g.MutationObserver; else g.MutationObserver = kept.observer;
    },
  };
}

/** One probe for the three hooks: the open state as an attribute, and a
 * door that toggles it. */
function Probe({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button data-probe data-open={String(open)} onClick={onToggle}>door</button>;
}

/** Tools closed and staying closed: this is the assistant's half of the slot. */
const SHUT_DRAWER = { open: false, closeReplaced: () => {} } as unknown as RecipeDrawerState;

function BuilderProbe() {
  const onToolsOpened = useRef<(() => void) | null>(null);
  const slot = useHelperSlot(SHUT_DRAWER, onToolsOpened);
  return <Probe open={slot.assistantVisible} onToggle={slot.toggleAssistant} />;
}
function SqlProbe() {
  const assistant = useSqlAssistant();
  return <Probe open={assistant.open} onToggle={assistant.toggle} />;
}
function CanvasProbe() {
  const assistant = useWorkflowAssistant(() => {});
  return <Probe open={assistant.open} onToggle={assistant.toggle} />;
}

const HOSTS = [
  { page: "a map", Host: BuilderProbe },
  { page: "/sql", Host: SqlProbe },
  { page: "a workflow", Host: CanvasProbe },
] as const;

describe("the assistant pane starts closed on every page open", () => {
  let host: ReturnType<typeof installDomHost>;
  let bits: ReturnType<typeof installBrowserBits>;
  let live: { container: HostElement; root: ReturnType<typeof createRoot> }[] = [];

  async function open(node: ReactNode) {
    const container = host.document.body.appendChild(host.document.createElement("div"));
    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(node); });
    const entry = { container, root };
    live.push(entry);
    const probe = () => container.querySelector("[data-probe]")!;
    return {
      /** What the pane's open state reads on this page. */
      state: () => probe().getAttribute("data-open"),
      click: async () => { await act(async () => { probe().click(); }); },
      /** Leaving the page. */
      leave: async () => {
        await act(async () => root.unmount());
        host.document.body.removeChild(container);
        live = live.filter((l) => l !== entry);
      },
    };
  }

  beforeEach(() => {
    host = installDomHost();
    bits = installBrowserBits(host.window);
  });
  afterEach(async () => {
    for (const { container, root } of live) {
      await act(async () => root.unmount());
      host.document.body.removeChild(container);
    }
    live = [];
    bits.uninstall();
    host.uninstall();
  });

  for (const { page, Host } of HOSTS) {
    it(`${page} opens with the pane closed, whatever the browser remembers`, async () => {
      bits.storage.setItem(MEMORY_KEY, "true");
      const visit = await open(<Host />);
      expect(visit.state()).toBe("false");
    });

    it(`${page} opens the pane on a click of its door`, async () => {
      const visit = await open(<Host />);
      await visit.click();
      expect(visit.state()).toBe("true");
    });

    it(`${page} opened by hand leaves the next page's pane closed`, async () => {
      const first = await open(<Host />);
      await first.click();
      expect(first.state()).toBe("true");
      await first.leave();
      const next = await open(<Host />);
      expect(next.state()).toBe("false");
    });
  }
});
