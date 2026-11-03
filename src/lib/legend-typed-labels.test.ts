import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { testClient } from "@/lib/mcp/test-client";
import { effectiveStyle, type LayerViz } from "@/lib/viz";
import type { LayerStyle, QuantileFill } from "@/lib/style/style";
import { LegendPanel } from "@/components/map/LegendPanel";
import { HostElement, installDomHost } from "@/components/testing/dom-host";
import { journeyClient } from "../../scripts/mcp-journey-core.mjs";

/**
 * Typed class labels across the two automatic forms. Overrides are
 * positional, so a change between the whole-number form and the boundary
 * form, which keeps the number of classes, keeps them; clearing one returns
 * that slot to the automatic text; and a change in the number of classes
 * resets them, as it always has. Read as the legend draws them.
 */

// The legend's width fit measures laid-out text, which the node host has none of.
vi.mock("@/components/map/legend-fit", () => ({ fitLegendWidth: () => {} }));

let dir: string;
let client: Awaited<ReturnType<typeof testClient>>;
let journey: Awaited<ReturnType<typeof journeyClient>>;
const api = async (url: string) =>
  (await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`))).json();

beforeAll(async () => {
  await mkdir(".claude", { recursive: true });
  dir = await mkdtemp(`${process.cwd()}/.tmp-typed-labels-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
  client = await testClient(dispatchAssistantTestRoute);
  journey = await journeyClient(client, api);
});
afterAll(async () => {
  await client?.close();
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const SQL = `SELECT (i % 4 + 1)::INTEGER AS n, ST_Point(13 + i * 0.01, 52) AS geometry FROM range(0, 40) AS t(i)`;

interface Stored {
  id: string;
  name: string;
  editRevision: string;
  style: LayerStyle;
  viz: LayerViz;
  legendLabels: (string | null)[] | null;
}

const read = (l: { id: string }): Promise<Stored> => journey.call("get_layer", { id: l.id });
async function update(l: { id: string }, fields: Record<string, unknown>): Promise<Stored> {
  return journey.call("update_layer", { id: l.id, expected_revision: (await read(l)).editRevision, ...fields });
}

/** The class texts the legend draws for a stored layer, overrides in place. */
function drawn(l: Stored): string[] {
  const html = renderToStaticMarkup(createElement(LegendPanel, {
    layers: [{ id: l.id, name: l.name, style: effectiveStyle(l.style, l.viz), visible: true, viz: l.viz, legendLabels: l.legendLabels }],
  }));
  return [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&gt;/g, ">"));
}

/** A layer classed into four whole-number classes, the second one typed. */
async function typed(): Promise<Stored> {
  const map = await journey.call("create_map", { name: "Typed" });
  const layer: Stored = await journey.call("create_layer", { id: map.id, name: "Counts", expected_revision: map.editRevision, sql: SQL });
  const paint: QuantileFill = await journey.call("compute_fill", { id: layer.id, attribute: "n", method: "natural", classes: 4 });
  expect([paint.breaks, paint.wholeNumbers]).toEqual([[1, 2, 3], true]);
  await update(layer, { style: { ...layer.style, fill: paint }, legendLabels: [null, "pairs", null, null] });
  const stored = await read(layer);
  expect(drawn(stored)).toEqual(["≤ 1", "pairs", "3", "> 3"]);
  return stored;
}

describe("typed class labels", () => {
  it("survive a change between the two forms that keeps the classes", async () => {
    const l = await typed();
    // A SQL change clears the fact: the same four slots read in the boundary form.
    await update(l, { sql: SQL.replace("::INTEGER", "::DOUBLE") });
    const after = await read(l);
    expect(after.legendLabels).toEqual([null, "pairs", null, null]);
    expect(drawn(after)).toEqual(["≤ 1", "pairs", "2 – 3", "> 3"]);
    // A computation back on the whole numbers returns the other form, label kept.
    await update(l, { sql: SQL });
    const paint: QuantileFill = await journey.call("compute_fill", { id: l.id, attribute: "n", method: "natural", classes: 4 });
    await update(l, { style: { ...after.style, fill: paint } });
    expect(drawn(await read(l))).toEqual(["≤ 1", "pairs", "3", "> 3"]);
  });

  it("return to the automatic text when cleared", async () => {
    const l = await typed();
    await update(l, { legendLabels: [null, null, null, null] });
    expect(drawn(await read(l))).toEqual(["≤ 1", "2", "3", "> 3"]);
  });

  it("reset when the number of classes changes", async () => {
    const l = await typed();
    const paint: QuantileFill = await journey.call("compute_fill", { id: l.id, attribute: "n", method: "natural", classes: 3 });
    expect(paint.colors).toHaveLength(3);
    await update(l, { style: { ...l.style, fill: paint } });
    const after = await read(l);
    expect(after.legendLabels).toBeNull();
    expect(drawn(after)).toEqual(["≤ 1", "2", "> 2"]);
  });

  it("clear on the map's own legend when emptied in place", async () => {
    const l = await typed();
    const host = installDomHost();
    const container = host.document.createElement("div");
    host.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const edits: [number, string | null][] = [];
    try {
      act(() => root.render(createElement(LegendPanel, {
        layers: [{ id: l.id, name: l.name, style: effectiveStyle(l.style, l.viz), visible: true, viz: l.viz, legendLabels: l.legendLabels }],
        onLabelEdit: (_id: string, slot: number, value: string | null) => { edits.push([slot, value]); },
      })));
      const button = container.querySelectorAll("button").find((b) => b.textContent === "pairs")!;
      act(() => button.click());
      const input = container.querySelector("input") as HostElement;
      const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"))!;
      const props = (input as unknown as Record<string, Record<string, (e: unknown) => void>>)[key];
      act(() => props.onChange({ target: { value: "  " } }));
      act(() => (input as unknown as Record<string, Record<string, (e: unknown) => void>>)[key].onBlur({}));
      expect(edits).toEqual([[1, null]]);
    } finally {
      act(() => root.unmount());
      host.uninstall();
    }
  });
});
