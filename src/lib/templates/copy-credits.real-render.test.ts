import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { delegateCredential } from "@/lib/auth/delegation";
import { requireRequestAuth } from "@/lib/auth/http";
import { resetQueryInstance } from "@/lib/duckdb";
import { lookAtMap } from "@/lib/export/map-look";
import { decodePng, type DecodedImage } from "@/lib/export/png-codec";
import { mapWithLayers } from "@/lib/map-access";
import { updateMap } from "@/lib/map-service";
import { closeMetadataDb } from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { buildTemplate, writeShippedFolder } from "../../../test-support/templates/builder";
import { startLoopbackBasemap } from "../../../scripts/loopback-basemap.mjs";
import { copyTemplate } from "./copy";
import * as shippedIndex from "./shipped-index";

/**
 * The copied credit note in an image of the copied map, drawn by the real
 * renderer: the bounded check through the real render road against a
 * production standalone that shares this process's data directory, the
 * basemap a loopback fixture. With the note visible the renderer reports it
 * among the widgets it drew and the widget rail carries its ink; hidden (and
 * still stored), the renderer leaves it out and the rail carries less.
 *
 * Provisioning as the map check's own real-render proof:
 * DEZFIL_MAP_LOOK_RENDER names the standalone's port; DEZFIL_DATA_DIR is the
 * directory both share; DEZFIL_CHROMIUM_PATH points at the headless shell;
 * DEZFIL_EGRESS_ALLOWLIST admits 127.0.0.1 for the loopback basemap.
 * Skipped without the port.
 */
const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const isInk = (r: number, g: number, b: number) => r < 110 && g < 110 && b < 110;

function inkInRail(image: DecodedImage): number {
  let n = 0;
  for (let y = 0; y < Math.floor(image.height * 0.6); y += 1) for (let x = Math.floor(image.width * 0.7); x < image.width; x += 1) {
    const i = (y * image.width + x) * 4;
    if (isInk(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2])) n += 1;
  }
  return n;
}

describe.skipIf(!port)("the copied credit note in an image drawn by the real renderer", () => {
  let mapId: string;
  let noteId: string;
  let shipped: string;
  let basemap: Awaited<ReturnType<typeof startLoopbackBasemap>>;
  const revision = () => readDocumentRevision({ kind: "map", id: mapId })?.editRevision;

  beforeAll(async () => {
    if (!process.env.DEZFIL_DATA_DIR) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    vi.stubEnv("PORT", port!);
    closeMetadataDb(); resetQueryInstance();
    basemap = await startLoopbackBasemap();
    shipped = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-credits-render-"));
    const template = await buildTemplate(path.join(shipped, "built"), { id: "harbour-stations" });
    vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(shipped, "shipped"), [template]));
    const copy = await copyTemplate(testAccountScope(), "harbour-stations");
    mapId = copy.members.maps[0].id;
    updateMap(testAccountScope(), mapId, {
      customBasemap: { url: basemap.styleUrl, name: "Loopback", attribution: [{ label: "Loopback fixture" }] },
    }, { expectedRevision: revision() });
    noteId = mapWithLayers(testAccountScope(), mapId).widgets.find((w) => w.type === "note")!.id;
  }, 120_000);
  afterAll(async () => {
    await basemap?.close();
    await rm(shipped, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const look = async () => {
    const result = await lookAtMap(testAccountScope(), { mapId, credential: delegateCredential(requireRequestAuth(authenticatedRequest())), baseUrl: `http://127.0.0.1:${port}` });
    return { result, decoded: decodePng(result.image.png) };
  };

  it("draws the note while it is visible, and leaves it out once hidden, still stored", async () => {
    const shown = await look();
    expect(shown.result.composition.failures).toEqual([]);
    expect(shown.result.state.widgets).toContain(noteId);
    const widgets = mapWithLayers(testAccountScope(), mapId).widgets;
    updateMap(testAccountScope(), mapId, { widgets: widgets.map((w) => (w.id === noteId ? { ...w, visible: false } : w)) }, { expectedRevision: revision() });
    const hidden = await look();
    expect(hidden.result.state.widgets).not.toContain(noteId);
    expect(inkInRail(hidden.decoded)).toBeLessThan(inkInRail(shown.decoded));
    expect(mapWithLayers(testAccountScope(), mapId).widgets.find((w) => w.id === noteId)).toMatchObject({ visible: false });
  }, 120_000);
});
