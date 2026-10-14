import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { MAX_FIELD_LIST } from "@/lib/column-validation";
import { PATCH } from "./route";

/**
 * The layer route's list caps: the column-list surfaces refuse entries
 * beyond the documented cap at the route edge, before any semantic
 * resolution.
 */

let dir: string;
let layerId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const source = path.join(dir, "points.csv");
  await writeFile(source, "name,val,lon,lat\na,1,13.4,52.5\n");
  await ingestFile(testAccountScope(), source, "points.csv");
  const map = createMap(testAccountScope(), "caps");
  const layer = await createLayer(testAccountScope(), map.id, {
    name: "l",
    sql: "SELECT * FROM points",
  }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  layerId = layer.id;
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function patch(body: unknown, basis: string) {
  return PATCH(
    testAccountRequest(new Request(`http://test/api/layers/${layerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "X-Edit-Revision": basis },
      body: JSON.stringify(body),
    })),
    { params: Promise.resolve({ id: layerId }) },
  );
}

describe("column-list caps", () => {
  const oversized = Array.from({ length: MAX_FIELD_LIST + 1 }, () => "name");

  for (const surface of ["tooltip", "popup", "publishedFields"] as const) {
    it(`${surface} refuses entries beyond the documented cap`, async () => {
      const response = await patch({ [surface]: oversized }, readEditRevision({ kind: "map", id: readEditLayer(layerId)!.mapId })!.editRevision!);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain(String(MAX_FIELD_LIST));
    });
  }

  it("a list at the cap passes the edge and resolves semantically", async () => {
    const atCap = Array.from({ length: MAX_FIELD_LIST }, () => "name");
    const response = await patch({ tooltip: atCap }, readEditRevision({ kind: "map", id: readEditLayer(layerId)!.mapId })!.editRevision!);
    expect(response.status).toBe(200);
  });
});

describe("custom icon markup at the layer gate", () => {
  it("sanitizes incoming customSvg — only accepted output is stored", async () => {
    const res = await patch({
      viz: {
        type: "icon",
        glyph: "marker",
        customSvg:
          '<svg viewBox="0 0 4 4"><path d="M0 0h4" onclick="x()"/></svg>',
      },
    }, readEditRevision({ kind: "map", id: readEditLayer(layerId)!.mapId })!.editRevision!);
    expect(res.status).toBe(200);
    const layer = (await res.json()) as {
      viz: { customSvg: string };
    };
    expect(layer.viz.customSvg).not.toContain("onclick");
    expect(layer.viz.customSvg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("clearing reveals the glyph; hostile-only markup answers invalid_request", async () => {
    await patch({
      viz: {
        type: "icon",
        glyph: "cafe",
        customSvg: '<svg viewBox="0 0 4 4"><path d="M0 0h4"/></svg>',
      },
    }, readEditRevision({ kind: "map", id: readEditLayer(layerId)!.mapId })!.editRevision!);
    const cleared = await patch({
      viz: { type: "icon", glyph: "cafe", customSvg: null },
    }, readEditRevision({ kind: "map", id: readEditLayer(layerId)!.mapId })!.editRevision!);
    const layer = (await cleared.json()) as {
      viz: { glyph: string; customSvg: null };
    };
    expect(layer.viz.customSvg).toBeNull();
    expect(layer.viz.glyph).toBe("cafe");

    const hostile = await patch({
      viz: {
        type: "icon",
        glyph: "cafe",
        customSvg: '<svg viewBox="0 0 1 1"><script>x</script></svg>',
      },
    }, readEditRevision({ kind: "map", id: readEditLayer(layerId)!.mapId })!.editRevision!);
    expect(hostile.status).toBe(400);
  });
});

it.each(["undefined", "fillOpactiy", "constructor"])("refuses an unknown style key %s without storing any edit", async key => {
  const before = readEditLayer(layerId)!;
  const revision = readEditRevision({ kind: "map", id: before.mapId })!.editRevision!;
  const response = await patch({ name: "Must not land", style: { ...before.style, [key]: 1 } }, revision);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "invalid_request", message: `The style is not valid: Unknown style key: ${key}.` } });
  expect(readEditLayer(layerId)).toEqual(before);
  expect(readEditRevision({ kind: "map", id: before.mapId })!.editRevision).toBe(revision);
});
