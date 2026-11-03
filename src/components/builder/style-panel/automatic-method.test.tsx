import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Layer } from "@/lib/metadata/maps";
import type { LayerField } from "@/lib/layer-service";
import { defaultStyle } from "@/lib/style/defaults";
import type { FillPaint, QuantileFill } from "@/lib/style/style";
import type { LayerViz } from "@/lib/viz";
import { HostElement, installDomHost } from "../../testing/dom-host";
import { wire, type Wire } from "../../workflow-canvas/fetch-wire";
import { PaintControls, paintControlsOpenState } from "./PaintControls";
import { useStyleEditing } from "./use-style-editing";

/**
 * A new classed colour in the Style panel starts on the method its values
 * suit: Natural breaks on whole numbers, Quantile on any other number,
 * judged per coloured field (on cells that average, the count is whole and
 * the value is not). The new gestures are choosing a numeric attribute and
 * switching Continuous to Classified. Where Natural refuses the data (all
 * values equal) the panel asks again with Quantile; a permission, a
 * cancellation or a resource failure is shown as it is. A method someone
 * picks, one the paint holds, an absent one and a continuous scale are
 * kept. Seeded defect: the fixed Quantile this replaced, which fails every
 * whole-number case and the fallback.
 */

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); });
const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });

const numeric = (name: string, type: string): LayerField => ({ name, type, numeric: true, kind: "numeric" }) as LayerField;
const COLUMNS = [numeric("n", "BIGINT"), numeric("x", "DOUBLE")];
const CELLS = [numeric("value", "DOUBLE"), numeric("count", "BIGINT")];
const FILL = "/api/layers/layer/fill";

const classed = (attribute: string, method: string): QuantileFill => ({
  type: "quantile", attribute, method: method as QuantileFill["method"], palette: "global_warming", breaks: [2, 5],
  colors: [{ r: 1, g: 2, b: 3, a: 1 }, { r: 4, g: 5, b: 6, a: 1 }, { r: 7, g: 8, b: 9, a: 1 }],
});
const continuousOver = (attribute: string): FillPaint => ({
  type: "continuous", attribute, palette: "global_warming", domain: [0, 10],
  stops: [{ r: 1, g: 2, b: 3, a: 1 }, { r: 7, g: 8, b: 9, a: 1 }],
} as FillPaint);

function mount(viz: LayerViz = { type: "points" }, fill?: FillPaint) {
  const w: Wire = wire(); vi.stubGlobal("fetch", w.fetch);
  const host = installDomHost();
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const style = { ...defaultStyle("POINT"), ...(fill && viz.type === "points" ? { fill } : {}) };
  const initial = { id: "layer", sql: "SELECT 1", style, viz: fill && viz.type !== "points" ? { ...viz, fill } : viz, filters: [], tooltip: null, popup: null } as unknown as Layer;
  function Panel() {
    const [layer, setLayer] = useState(initial);
    const e = useStyleEditing({
      layer,
      onStyle: (next) => setLayer((l) => ({ ...l, style: next })),
      onViz: (next) => setLayer((l) => ({ ...l, viz: next })),
    });
    // The panel shows a channel's failure above its controls.
    return (
      <>
        {e.channelError && <p>{e.channelError}</p>}
        <PaintControls paint={e.fill} fields={e.stylingFields} disabled={e.busy} channel="Fill"
          constantFallback={{ r: 1, g: 1, b: 1, a: 1 }} classify={e.classify} fetchStats={e.fetchStats} onPaint={e.setFillPaint} />
      </>
    );
  }
  const props = (el: HostElement) => {
    const key = Object.keys(el).find((name) => name.startsWith("__reactProps$"))!;
    return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key];
  };
  // Outside the builder the panel reads its fields again on every layer
  // change; the same answer stands each time.
  const fields = () => flush(() => w.pending("GET", "/api/layers/layer/fields")
    .forEach((read) => read.ok({ styling: viz.type === "points" ? COLUMNS : CELLS, filterable: COLUMNS, geometryColumns: ["geometry"] })));
  return {
    w,
    start: async () => {
      await flush(() => root.render(<Panel />));
      await fields();
    },
    choose: (name: string, value: string) =>
      flush(() => props(container.querySelectorAll("select").find((s) => s.getAttribute("aria-label") === name)!).onChange({ target: { value } })),
    click: (text: string) => flush(() => props(container.querySelectorAll("button").find((b) => b.textContent === text)!).onClick({})),
    /** The method each classification asked for, in order. */
    asked: () => w.calls.filter((c) => c.method === "POST" && c.path === FILL).map((c) => (c.body as { method: string }).method),
    answer: async (paint: FillPaint) => {
      await flush(() => w.pending("POST", FILL)[0].ok(paint));
      await fields();
    },
    text: () => container.textContent,
  };
}

describe("a new classed colour", () => {
  it("starts on Natural breaks over a whole-number column and Quantile over a decimal one", async () => {
    const panel = mount();
    await panel.start();
    await panel.choose("Fill color attribute", "n");
    expect(panel.asked()).toEqual(["natural"]);
    await panel.answer(classed("n", "natural"));
    await panel.choose("Fill color attribute", "x");
    expect(panel.asked()).toEqual(["natural", "quantile"]);
  });

  it("judges each coloured field on cells: an average's value is not whole, its count is, a count's value is", async () => {
    const averaged = mount({ type: "hexbin", cellKm: 2, aggregate: { fn: "avg", attribute: "x" } } as LayerViz);
    await averaged.start();
    await averaged.choose("Fill color attribute", "value");
    await averaged.answer(classed("value", "quantile"));
    await averaged.choose("Fill color attribute", "count");
    expect(averaged.asked()).toEqual(["quantile", "natural"]);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    const counted = mount({ type: "hexbin", cellKm: 2, aggregate: { fn: "count" } } as LayerViz);
    await counted.start();
    await counted.choose("Fill color attribute", "value");
    expect(counted.asked()).toEqual(["natural"]);
  });

  it("keeps a continuous scale on a new attribute, and starts the same way when switched to Classified", async () => {
    const panel = mount({ type: "points" }, continuousOver("x"));
    await panel.start();
    await panel.choose("Fill color attribute", "n");
    expect(panel.asked()).toEqual(["continuous"]);
    await panel.answer(continuousOver("n"));
    await panel.click("Classified");
    expect(panel.asked()).toEqual(["continuous", "natural"]);
    expect((panel.w.pending("POST", FILL)[0].body as { classes: number }).classes).toBe(5);
  });

  it("asks again with Quantile when Natural refuses all-equal values", async () => {
    const panel = mount();
    await panel.start();
    await panel.choose("Fill color attribute", "n");
    await flush(() => panel.w.pending("POST", FILL)[0].refuse(400, "invalid_request", 'Column "n" has no numeric values to classify.'));
    expect(panel.asked()).toEqual(["natural", "quantile"]);
    await panel.answer(classed("n", "quantile"));
    expect(panel.text()).not.toContain("no numeric values");
    expect(paintControlsOpenState(classed("n", "quantile"), COLUMNS).method).toBe("quantile");
  });

  it.each([
    [404, "not_found", "Layer not found."],
    [503, "engine_memory_exceeded", "The query ran out of memory."],
    [408, "query_timeout", "The query took too long."],
    [499, "internal", "The request was cancelled."],
  ])("shows a %s %s refusal as it is, without asking again", async (status, code, message) => {
    const panel = mount();
    await panel.start();
    await panel.choose("Fill color attribute", "n");
    await flush(() => panel.w.pending("POST", FILL)[0].refuse(status, code, message));
    expect(panel.asked()).toEqual(["natural"]);
    expect(panel.text()).toContain(message);
  });

  it("honours a method someone picks, either way", async () => {
    const panel = mount({ type: "points" }, classed("n", "natural"));
    await panel.start();
    await panel.choose("Fill classification method", "quantile");
    await panel.answer(classed("n", "quantile"));
    await panel.choose("Fill color attribute", "x");
    await panel.answer(classed("x", "quantile"));
    await panel.choose("Fill classification method", "natural");
    expect(panel.asked()).toEqual(["quantile", "quantile", "natural"]);
  });
});

describe("a paint that already holds a method", () => {
  it("keeps its saved method, Quantile when none is saved, and Custom's own", () => {
    const { method: _absent, ...noMethod } = classed("n", "quantile");
    void _absent;
    expect(paintControlsOpenState(classed("n", "equal"), COLUMNS).namedMethod).toBe("equal");
    expect(paintControlsOpenState(noMethod as QuantileFill, COLUMNS).namedMethod).toBe("quantile");
    expect(paintControlsOpenState({ ...classed("n", "custom"), baseMethod: "equal" }, COLUMNS).namedMethod).toBe("equal");
  });
});
