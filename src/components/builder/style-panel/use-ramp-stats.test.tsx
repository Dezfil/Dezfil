import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostElement, installDomHost } from "@/components/testing/dom-host";
import type { FieldStats } from "@/lib/layer-service";
import type { LayerViz } from "@/lib/viz";
import { useRampStats, type FetchStats } from "./use-ramp-stats";
import { distributionSource } from "./use-stats-source";

/**
 * A ramp's distribution is shown only while the attribute, the request and
 * the source it answered are all current. The seeded defect is the keying
 * this replaced, by attribute alone: after a SQL, filter or aggregation
 * change, or a switch of the request, it kept drawing the old answer while
 * the new one was in flight, and for good when that one failed.
 */

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const stats = (min: number): FieldStats => ({ field: "v", kind: "numeric", numeric: true, min, max: 10, mean: 5, bins: [1] });

/** A fetcher whose answers the test releases by hand. */
function fetcher() {
  const pending: { attribute: string; distribution?: string; resolve: (s: FieldStats | null) => void }[] = [];
  const fetch: FetchStats = (attribute, distribution) =>
    new Promise((resolve) => pending.push({ attribute, distribution, resolve }));
  return { fetch, pending };
}

/** Draws the minimum of the answer it is shown, or "none". */
function Probe(props: { fetch: FetchStats; attribute: string | null; distribution?: "classification" }) {
  const stats = useRampStats(props.fetch, props.attribute, props.distribution);
  return <i data-shown={stats === null ? "none" : String(stats.kind === "numeric" ? stats.min : "?")} />;
}
const shown = () => container.querySelector("i")?.getAttribute("data-shown");
const render = (props: Parameters<typeof Probe>[0]) => act(() => root.render(<Probe {...props} />));
const answer = async (p: { resolve: (s: FieldStats | null) => void }, s: FieldStats | null) => {
  await act(async () => p.resolve(s));
};

describe("a ramp's distribution", () => {
  it("shows the answer for the attribute, request and source it was asked for", async () => {
    const a = fetcher();
    render({ fetch: a.fetch, attribute: "v", distribution: "classification" });
    expect(a.pending.map((p) => [p.attribute, p.distribution])).toEqual([["v", "classification"]]);
    expect(shown()).toBe("none");
    await answer(a.pending[0], stats(1));
    expect(shown()).toBe("1");
  });

  it("hides the old answer while a changed source's is in flight, and after it fails", async () => {
    const before = fetcher();
    render({ fetch: before.fetch, attribute: "v" });
    await answer(before.pending[0], stats(1));
    const after = fetcher();
    render({ fetch: after.fetch, attribute: "v" });
    expect(shown()).toBe("none");
    await answer(after.pending[0], null);
    expect(shown()).toBe("none");
  });

  it("ignores a late answer from a source that has since changed", async () => {
    const before = fetcher();
    render({ fetch: before.fetch, attribute: "v" });
    const after = fetcher();
    render({ fetch: after.fetch, attribute: "v" });
    await answer(before.pending[0], stats(1));
    expect(shown()).toBe("none");
    await answer(after.pending[0], stats(2));
    expect(shown()).toBe("2");
  });

  it("asks again, and hides the old answer, when the request changes", async () => {
    const a = fetcher();
    render({ fetch: a.fetch, attribute: "v" });
    await answer(a.pending[0], stats(1));
    render({ fetch: a.fetch, attribute: "v", distribution: "classification" });
    expect(shown()).toBe("none");
    expect(a.pending.at(-1)?.distribution).toBe("classification");
  });
});

describe("the values' source", () => {
  const hex = (fill?: unknown): LayerViz => ({ type: "hexbin", cellKm: 2, aggregate: { fn: "count" }, ...(fill ? { fill } : {}) }) as LayerViz;

  it("moves with the SQL, the filters and the aggregation", () => {
    const base = distributionSource("SELECT 1", [], hex());
    expect(distributionSource("SELECT 2", [], hex())).not.toBe(base);
    expect(distributionSource("SELECT 1", [{ field: "v", kind: "range", min: 1, max: null }], hex())).not.toBe(base);
    expect(distributionSource("SELECT 1", [], { ...hex(), cellKm: 3 } as LayerViz)).not.toBe(base);
    expect(distributionSource("SELECT 1", [], { ...hex(), aggregate: { fn: "avg", attribute: "v" } } as LayerViz)).not.toBe(base);
    expect(distributionSource("SELECT 1", [], { type: "points" })).not.toBe(base);
  });

  it("stays put when only the paint over the values changes", () => {
    expect(distributionSource("SELECT 1", [], hex({ type: "constant", color: { r: 1, g: 1, b: 1, a: 1 } }))).toBe(
      distributionSource("SELECT 1", [], hex()),
    );
  });
});
