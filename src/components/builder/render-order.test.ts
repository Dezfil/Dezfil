import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LayerRenderData } from "./render-data";
import { RenderOrder, type Renders } from "./render-order";

const render = (layerId: string, label: string): LayerRenderData =>
  ({ layerId, ok: true, mode: "inline", geojson: { type: "FeatureCollection", features: [], label } }) as LayerRenderData;

describe("the render ordering rule", () => {
  it("drops an answer that lands after one sent later", () => {
    const order = new RenderOrder();
    const older = order.request("a");
    const newer = order.request("a");
    const shown = order.answer({}, "a", newer, render("a", "newer"))!;
    expect(shown).toEqual({ a: render("a", "newer") });
    expect(order.answer(shown, "a", older, render("a", "older"))).toBeNull();
  });

  it("shows an earlier answer that lands first until the later one arrives", () => {
    const order = new RenderOrder();
    const earlier = order.request("a");
    const later = order.request("a");
    const first = order.answer({ a: render("a", "before") }, "a", earlier, render("a", "earlier"))!;
    expect(first).toEqual({ a: render("a", "earlier") });
    expect(order.answer(first, "a", later, render("a", "later"))).toEqual({ a: render("a", "later") });
  });

  it("keeps each layer's order to itself", () => {
    const order = new RenderOrder();
    const a = order.request("a");
    const b = order.request("b");
    const shown = order.answer({}, "b", b, render("b", "b"))!;
    expect(order.answer(shown, "a", a, render("a", "a"))).toEqual({ a: render("a", "a"), b: render("b", "b") });
  });

  it("lets a replacement overtake every request sent before it and drop the layers it does not list at once", () => {
    const order = new RenderOrder();
    const shown: Renders = { a: render("a", "before"), b: render("b", "before") };
    const listedEarlier = order.request("a");
    const unlistedEarlier = order.request("b");
    const replacing = order.replace(shown, ["a"]);
    expect(replacing.shown).toEqual({ a: render("a", "before") });
    expect(order.answer(replacing.shown, "a", listedEarlier, render("a", "stale"))).toBeNull();
    expect(order.answer(replacing.shown, "b", unlistedEarlier, render("b", "stale"))).toBeNull();
    expect(order.settle(replacing.shown, replacing.ticket, { a: render("a", "replaced") })).toEqual({ a: render("a", "replaced") });
  });

  it("keeps a request sent after a replacement ahead of the replacement's own answer", () => {
    const order = new RenderOrder();
    const replacing = order.replace({}, ["a", "b"]);
    const later = order.request("a");
    const shown = order.answer(replacing.shown, "a", later, render("a", "later"))!;
    expect(order.settle(shown, replacing.ticket, { a: render("a", "replaced"), b: render("b", "replaced") }))
      .toEqual({ a: render("a", "later"), b: render("b", "replaced") });

    // The replacement landing first is shown, then the later answer.
    const reversed = new RenderOrder();
    const replacingFirst = reversed.replace({}, ["a"]);
    const pending = reversed.request("a");
    const settled = reversed.settle({}, replacingFirst.ticket, { a: render("a", "replaced") })!;
    expect(settled).toEqual({ a: render("a", "replaced") });
    expect(reversed.answer(settled, "a", pending, render("a", "later"))).toEqual({ a: render("a", "later") });
  });

  it("lets a later replacement overtake an earlier one", () => {
    const order = new RenderOrder();
    const earlier = order.replace({}, ["a"]);
    const later = order.replace({}, ["a"]);
    expect(order.settle({}, earlier.ticket, { a: render("a", "earlier") })).toBeNull();
    expect(order.settle({}, later.ticket, { a: render("a", "later") })).toEqual({ a: render("a", "later") });
  });

  it("drops a removed layer with its answers in flight until a replacement lists it again", () => {
    const order = new RenderOrder();
    const inFlight = order.request("a");
    const shown = order.remove({ a: render("a", "before"), b: render("b", "kept") }, "a");
    expect(shown).toEqual({ b: render("b", "kept") });
    expect(order.answer(shown, "a", inFlight, render("a", "late"))).toBeNull();
    // Asking again does not bring it back; only the map listing it does.
    const asked = order.request("a");
    expect(order.answer(shown, "a", asked, render("a", "asked"))).toBeNull();
    const restored = order.replace(shown, ["a", "b"]);
    expect(order.settle(restored.shown, restored.ticket, { a: render("a", "restored"), b: render("b", "kept") }))
      .toEqual({ a: render("a", "restored"), b: render("b", "kept") });
  });

  it("drops a request in flight for a layer a replacement leaves out, even if it was never shown", () => {
    const order = new RenderOrder();
    const copy = order.request("copy");
    const replacing = order.replace({}, ["a"]);
    expect(order.answer(replacing.shown, "copy", copy, render("copy", "late"))).toBeNull();
    expect(order.answer(replacing.shown, "copy", order.request("copy"), render("copy", "asked"))).toBeNull();
  });

  it("keeps a layer that joined after a replacement when the replacement settles", () => {
    const order = new RenderOrder();
    const replacing = order.replace({}, ["a"]);
    const copy = order.request("copy");
    const shown = order.answer(replacing.shown, "copy", copy, render("copy", "copy"))!;
    expect(order.settle(shown, replacing.ticket, { a: render("a", "replaced") }))
      .toEqual({ copy: render("copy", "copy"), a: render("a", "replaced") });
  });

  it("does not starve a slow layer whose next request goes out before its answer lands", () => {
    const order = new RenderOrder();
    let shown: Renders = { slow: render("slow", "building") };
    // Each poll round asks again while the previous answer is still out;
    // every answer that lands is newer than what the layer shows.
    const rounds = [order.request("slow"), order.request("slow"), order.request("slow")];
    for (const [i, ticket] of rounds.entries()) {
      shown = order.answer(shown, "slow", ticket, render("slow", `round ${i}`)) ?? shown;
      expect(shown.slow).toEqual(render("slow", `round ${i}`));
    }
  });

  it("returns the shown set itself when a replacement drops nothing", () => {
    const order = new RenderOrder();
    const shown = { a: render("a", "a") };
    expect(order.replace(shown, ["a", "b"]).shown).toBe(shown);
  });
});

it("writes the builder's render answers only through the ordering rule", () => {
  // The shown set has one writer: a new path that set it directly would
  // skip the rule, which is how an older answer overwrote a newer one.
  const root = "src/components/builder";
  const writers = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => {
      const source = readFileSync(path.join(root, file), "utf8");
      return /\bsetRenders\b|\brendersRef\.current\s*=[^=]/.test(source);
    });
  expect(writers).toEqual(["use-layer-renders.ts"]);
});
