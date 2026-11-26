import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { CHANGE_GROUP_HEADER } from "@/lib/api/change-group";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { defaultStyle } from "@/lib/style/defaults";
import type { LabelStyle, LayerStyle } from "@/lib/style/style";
import { HostElement, installDomHost } from "../../testing/dom-host";
import { LabelToneContext } from "../label-tone";
import { LabelSection } from "./LabelSection";
import { useLabelSetters } from "./use-label-setters";

/**
 * What the Label section writes, saved, read back, undone and redone: the
 * styles it sends on its own controls (labels on, a halo width, a text
 * colour, then each part back to Automatic) go to the real server one save
 * at a time. Each save, read back as a reload reads it, keeps both choices
 * and every colour of the label's own; undo walks back through each state
 * and redo forward again; and the section shown over a label read back
 * says what it said before the save. The map's basemap is Auto, so its
 * stored fallbacks are the light recipe, while the section is painted for
 * a dark map: a halo made its own keeps the dark rim it showed.
 */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(`${process.cwd()}/.tmp-label-section-kept-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
});
afterAll(async () => {
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

// Written out here, not read from the code under test.
const LIGHT_TEXT = { r: 36, g: 50, b: 48, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const DARK_HALO = { r: 11, g: 14, b: 20, a: 1 };
const RED = { r: 200, g: 40, b: 40, a: 1 };

const props = (element: HostElement) => {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (e: unknown) => void>>)[key];
};

/** The section over its own setters on a dark map, holding its style as the
 * builder does. Returns the container and the styles it sent, in order. */
function mountSection(start: LayerStyle) {
  const sent: LayerStyle[] = [];
  function Panel() {
    const [style, setStyle] = useState<LayerStyle>(start);
    const patch = (partial: Partial<LayerStyle>) => {
      const next = { ...style, ...partial };
      sent.push(next);
      setStyle(next);
    };
    const { setLabelAttribute, setCellLabels } = useLabelSetters("kept", style.label, patch);
    return (
      <LabelToneContext.Provider value="dark">
        <LabelSection label={style.label} aggregated={false} tiled={false} stylingFields={[{ name: "name" }]}
          numericFields={[]} count={null} setCellLabels={setCellLabels} setLabelAttribute={setLabelAttribute} patch={patch} />
      </LabelToneContext.Provider>
    );
  }
  const host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(<Panel />));
  const choices = () => [...container.querySelectorAll("[data-paint-choice]")].map((e) => e.getAttribute("data-paint-choice"));
  const unmount = () => { act(() => root.unmount()); host.uninstall(); };
  return { container, sent, choices, unmount };
}

async function http(method: string, url: string, revision?: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (revision) headers["X-Edit-Revision"] = revision;
  // One step per save, as the section's separate gestures are.
  if (method === "PATCH") headers[CHANGE_GROUP_HEADER] = crypto.randomUUID();
  const response = await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  expect(response.status, `${method} ${url}`).toBeLessThan(300);
  return response.json();
}
const revision = (mapId: string) => readDocumentRevision({ kind: "map", id: mapId })!.editRevision!;

it("keeps each state the section writes through save and reload, undo and redo", async () => {
  // The section's gestures, each sent as the style the builder would save.
  const start = defaultStyle("POINT");
  const section = mountSection(start);
  const input = (name: string) => section.container.querySelector(`input[aria-label="${name}"]`)!;
  const back = (name: string) =>
    act(() => (input(name).parentNode as HostElement).querySelector('button[data-paint-choice="own"]')!.click());
  const shown: (string | null)[][] = [];
  const step = (gesture: () => void) => { gesture(); shown.push(section.choices()); };
  step(() => act(() => props(section.container.querySelector('select[aria-label="Label text"]')!).onChange({ target: { value: "name" } })));
  step(() => act(() => props(input("Halo width")).onChange({ target: { value: "2" } })));
  step(() => act(() => props(input("Label color")).onChange({ target: { value: "#c82828" } })));
  step(() => back("Label color"));
  step(() => back("Halo width"));
  section.unmount();
  expect(section.sent).toHaveLength(5);

  // What the server keeps of each: an automatic part with the map's light
  // fallbacks, a part of its own exactly as the section sent it.
  const followed: LabelStyle = {
    attribute: "name", size: 12,
    textPaint: "automatic", color: LIGHT_TEXT, haloPaint: "automatic", haloWidth: 1.5, haloColor: WHITE,
  };
  const ownHalo = { ...followed, haloPaint: "own" as const, haloWidth: 2, haloColor: DARK_HALO };
  const ownBoth = { ...ownHalo, textPaint: "own" as const, color: RED };
  const kept: LabelStyle[] = [followed, ownHalo, ownBoth, ownHalo, followed];
  expect(shown).toEqual([
    ["automatic", "automatic", "automatic"],
    ["automatic", "own", "own"],
    ["own", "own", "own"],
    ["automatic", "own", "own"],
    ["automatic", "automatic", "automatic"],
  ]);

  const scope = testAccountScope();
  const map = createMap(scope, "Kept");
  expect(map.basemap).toBeNull();
  const layer = await createLayer(scope, map.id, { name: "Places", sql: "SELECT 'Harbour' AS name, ST_Point(13.4, 52.5) AS geometry" },
    { expectedRevision: revision(map.id) });
  /** The label as a reload reads it, from the layer and from its map, which agree. */
  const reload = async () => {
    const fromLayer = (await http("GET", `/api/layers/${layer.id}`)).style.label;
    const fromMap = (await http("GET", `/api/maps/${map.id}`)).layers[0].style.label;
    expect(fromMap).toEqual(fromLayer);
    return fromLayer as LabelStyle | undefined;
  };

  const reloaded: LabelStyle[] = [];
  for (const [i, style] of section.sent.entries()) {
    const saved = await http("PATCH", `/api/layers/${layer.id}`, revision(map.id), { style });
    expect(saved.style.label, `save ${i + 1}`).toEqual(kept[i]);
    const read = await reload();
    expect(read, `reload ${i + 1}`).toEqual(kept[i]);
    reloaded.push(read!);
  }

  // Undo walks back through every saved state to no label; redo walks forward.
  for (let i = kept.length - 2; i >= -1; i -= 1) {
    const undone = await http("POST", `/api/maps/${map.id}/undo`, revision(map.id));
    expect(undone.layers[0].style.label, `undo to ${i + 1}`).toEqual(i < 0 ? undefined : kept[i]);
    expect(await reload()).toEqual(i < 0 ? undefined : kept[i]);
  }
  for (const [i, label] of kept.entries()) {
    const redone = await http("POST", `/api/maps/${map.id}/redo`, revision(map.id));
    expect(redone.layers[0].style.label, `redo to ${i + 1}`).toEqual(label);
    expect(await reload()).toEqual(label);
  }

  // The section over each label read back says what it said before the save.
  for (const [i, label] of reloaded.entries()) {
    const again = mountSection({ ...start, label });
    expect(again.choices(), `reloaded ${i + 1}`).toEqual(shown[i]);
    again.unmount();
  }
});
