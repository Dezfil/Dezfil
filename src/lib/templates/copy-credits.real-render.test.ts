import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { delegateCredential } from "@/lib/auth/delegation";
import { requireRequestAuth } from "@/lib/auth/http";
import { resetQueryInstance } from "@/lib/duckdb";
import { lookAtMap, setLookDriverForTests } from "@/lib/export/map-look";
import { decodePng, encodePng, type DecodedImage } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
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
 * Skipped without the port. A render credential is signed with a key each
 * process draws for itself, while here this process signs it and the
 * standalone serves the page that checks it: DEZFIL_RENDER_DELEGATION_KEY
 * (64 hexadecimal digits) gives this process the key, and the standalone
 * takes the same one at start with
 * `--import="data:text/javascript,process[Symbol.for('dezfil.session-delegation-key')]=Buffer.from(process.env.DEZFIL_RENDER_DELEGATION_KEY,'hex')"`.
 * Without it the page answers the sign-in redirect and every look runs
 * into its budget, so the setup refuses to start.
 * DEZFIL_MAP_LOOK_TRANSPORT_ONLY=1 is the named seed: a stub driver
 * answering a flat image while declaring what the stored map shows, which
 * must fail here, so a transport pass is distinguishable from a render.
 */
const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const transportOnly = process.env.DEZFIL_MAP_LOOK_TRANSPORT_ONLY === "1";
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");
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
  let heldKey: unknown;
  const revision = () => readDocumentRevision({ kind: "map", id: mapId })?.editRevision;

  beforeAll(async () => {
    if (!process.env.DEZFIL_DATA_DIR) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    const key = process.env.DEZFIL_RENDER_DELEGATION_KEY ?? "";
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("DEZFIL_RENDER_DELEGATION_KEY must carry the standalone's render signing key, 64 hexadecimal digits");
    const slots = process as unknown as Record<symbol, unknown>;
    heldKey = slots[SIGNING_KEY]; slots[SIGNING_KEY] = Buffer.from(key, "hex");
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
    const accepted = await fetch(`http://127.0.0.1:${port}/api/maps/${mapId}`, { headers: { authorization: `Bearer ${delegateCredential(requireRequestAuth(authenticatedRequest()))}` } });
    if (accepted.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${accepted.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);
    if (transportOnly) {
      // Declares what the stored map shows, the note's visibility included,
      // so only the pixels stand between this stub and a pass.
      const flat = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).fill(240) });
      const declared = () => {
        const map = mapWithLayers(testAccountScope(), mapId);
        return JSON.stringify({
          map: mapId, layers: map.layers.filter((l) => l.visible).map((l) => ({ id: l.id, filters: l.filters })),
          legend: { visible: true, corner: map.legendCorner ?? "bottom-right", order: map.legendOrder ?? [] },
          widgets: map.widgets.filter((w) => w.visible !== false).map((w) => w.id), attribution: "Loopback fixture", failures: [],
        });
      };
      const driver: RenderDriver = { launch: async () => ({ render: async () => ({ png: flat, consumed: declared() }), close: async () => {}, kill: () => {} }) };
      setLookDriverForTests(driver);
    }
  }, 120_000);
  afterAll(async () => {
    setLookDriverForTests(null);
    (process as unknown as Record<symbol, unknown>)[SIGNING_KEY] = heldKey;
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
