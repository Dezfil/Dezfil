import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { installDomHost } from "../testing/dom-host";
import { wire } from "../workflow-canvas/fetch-wire";
import { STALE_MESSAGE } from "../document-sequence";
import { useTransientNotice } from "../use-transient-notice";
import { SAVE_STATUS_EXIT_MS } from "../ui/SaveStatusChip";
import { BuilderStageControls } from "./BuilderStageControls";
import { useBuilderMutations } from "./use-builder-mutations";
import { useDrawSession } from "./draw/use-draw-session";

// Geometry is a browser concern; keep the real producers and stage chip.
vi.mock("./draw/DrawOverlay", () => ({ DrawOverlay: () => null }));
vi.mock("./draw/DrawDock", () => ({ DrawDock: () => null }));
vi.mock("./draw/DrawPill", () => ({ DrawPill: () => null }));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it.each([
  [409, "stale_revision", STALE_MESSAGE],
  [500, "internal", "The name could not be filed."],
] as const)("a covered drawing refusal (%s) lights its sentence after the preceding save settles", async (status, code, sentence) => {
  vi.useFakeTimers();
  const host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const initial = { id: "m", name: "Map", editRevision: "seen", layers: [], widgets: [] } as unknown as MapWithLayers;
  let mutations!: ReturnType<typeof useBuilderMutations>;
  let session!: ReturnType<typeof useDrawSession>;
  function Builder() {
    const [map, setMap] = useState<MapWithLayers | null>(initial);
    const rendersRef = useRef({});
    mutations = useBuilderMutations({ mapId: "m", map, setMap, rendersRef, setRenders() {}, setSelectedId() {}, refreshLayer: async () => {} });
    const notice = useTransientNotice();
    session = useDrawSession({ request: mutations.request, mapId: "m", announce: notice.show,
      onLayerMinted() {}, refreshTable() {}, reloadSketches: async () => {}, onSelectionGone() {} });
    const sequence = mutations.sequence;
    const server = mutations.serverMapRef;
    useEffect(() => { sequence.accept(initial); server.current = initial; }, [sequence, server]);
    return <BuilderStageControls cameraRef={{ current: null }} bearing={0} pitch={0} onFitAll={() => {}}
      mapFull={false} onMapFull={() => {}} drawCamera={null}
      draw={{ mode: { open: false, tool: null, selected: null }, session, selectedRing: null, moveVertex: session.moveVertex } as Parameters<typeof BuilderStageControls>[0]["draw"]}
      saving={!mutations.stale && mutations.pendingSaves > 0} notice={notice.notice} />;
  }
  const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });
  await flush(() => root.render(<Builder />));
  const line = (key: string) => host.document.querySelector(`[data-save-status="${key}"]`)!;
  let saved!: Promise<boolean>;
  await flush(() => { saved = mutations.patchMap({ name: "Renamed" }); });
  expect(line("saving").getAttribute("data-on")).toBe("true");
  expect(line("saving").textContent).toBe("Saving…");
  let drawn!: Promise<void>;
  await flush(() => { drawn = session.commit({ kind: "point", geometry: { type: "Point", coordinates: [13, 52] } }); });
  expect(w.pending("POST", "/api/maps/m/sketches")).toHaveLength(0);
  expect(line("notice").getAttribute("data-on")).toBeNull();
  await flush(() => w.pending("PATCH", "/api/maps/m")[0].ok({ ...initial, name: "Renamed", editRevision: "renamed" }));
  await saved;
  expect(line("saving").getAttribute("data-on")).toBeNull();
  const sketch = w.pending("POST", "/api/maps/m/sketches")[0];
  expect(sketch.headers.get("X-Edit-Revision")).toBe("renamed");
  await flush(() => sketch.refuse(status, code, sentence));
  await drawn;
  expect(line("notice").getAttribute("data-on")).toBe("true");
  expect(line("notice").textContent).toBe(sentence);
  expect(mutations.sequence.stale).toBe(code === "stale_revision");
  await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_STATUS_EXIT_MS); });
  expect(line("saving").textContent).toBe("");
  expect(line("saving").getAttribute("data-on")).toBeNull();
  expect(line("notice").getAttribute("data-on")).toBe("true");
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(line("notice").getAttribute("data-on")).toBeNull();
});
