import { expect, it } from "vitest";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { patchIntent } from "../document-sequence";
import { BuilderDrafts } from "./builder-drafts";

it("retires a nested correction while preserving sibling intent over the returned values", () => {
  const layer = { id: "a", style: { opacity: 1, fill: "red" } } as unknown as Layer;
  const map = { layers: [layer] } as MapWithLayers;
  const drafts = new BuilderDrafts();
  drafts.layer("a", patchIntent(layer, { style: { opacity: 0.5, fill: "yellow" } }));
  const shown = drafts.apply(map).layers[0];
  const correction = drafts.layer("a", patchIntent(shown, { style: { opacity: 0.5, fill: "blue" } }));
  drafts.accepted(correction, map);
  const returned = { ...map, layers: [{ ...layer, style: { ...layer.style, fill: "navy" } }] } as unknown as MapWithLayers;
  expect(drafts.apply(returned).layers[0].style).toEqual({ opacity: 0.5, fill: "navy" });
  expect(drafts.hasLayer("a")).toBe(true);
  const reset = drafts.layer("a", current => ({ style: { ...current.style, opacity: 1 } }));
  drafts.accepted(reset, returned);
  expect(drafts.hasLayer("a")).toBe(false);
  expect(drafts.apply(returned)).toEqual(returned);
});

it("retires only the corrected widget field, preserving other fields, IDs and newer drafts", () => {
  const widgets = [{ id: "a", title: "A", visible: true }, { id: "b", title: "B", visible: true }];
  const map = { layers: [], widgets, name: "original" } as unknown as MapWithLayers;
  const drafts = new BuilderDrafts();
  const failed = [{ ...widgets[0], title: "unsaved A", visible: false }, { ...widgets[1], title: "unsaved B" }];
  drafts.map(patchIntent(map, { widgets: failed }));
  const corrected = [{ ...failed[0], title: "corrected A" }, failed[1]];
  const ticket = drafts.map(patchIntent(drafts.apply(map), { widgets: corrected }));
  drafts.map(patchIntent(map, { name: "newer name" }));
  drafts.accepted(ticket, map);
  const returned = { ...map, widgets: [{ ...widgets[1] }, { ...widgets[0], title: "accepted A" }, { id: "c", title: "C", visible: true }] } as unknown as MapWithLayers;
  expect(drafts.apply(returned)).toMatchObject({ name: "newer name", widgets: [
    { id: "b", title: "unsaved B", visible: true },
    { id: "a", title: "accepted A", visible: false },
    { id: "c", title: "C", visible: true },
  ] });
});
