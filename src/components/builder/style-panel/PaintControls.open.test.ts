import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import {
  createLayer,
  layerFields,
  layerFieldStats,
  requireLayer,
  updateLayer,
} from "@/lib/layer-service";
import type { QuantileFill } from "@/lib/style/style";
import { paintControlsOpenState } from "./PaintControls";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(testDir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const source = path.join(testDir, "values.csv");
  await writeFile(
    source,
    "name,value,lon,lat\na,1000,13.4,52.5\nb,3500,13.5,52.6\nc,12000,13.6,52.7\n",
  );
  await ingestFile(testAccountScope(), source, "values.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(testDir, { recursive: true, force: true });
});

describe("opening a stored data-driven Fill panel", () => {
  it("leaves quantile breaks and colors byte-stable across the read path", async () => {
    const map = createMap(testAccountScope(), "Quantile inspection");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "Values",
      sql: "SELECT name, value, geometry FROM values",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const fill: QuantileFill = {
      type: "quantile",
      attribute: "value",
      method: "quantile",
      palette: "viridis",
      classes: 2,
      breaks: [12000],
      colors: [
        { r: 17, g: 41, b: 83, a: 1 },
        { r: 221, g: 197, b: 71, a: 1 },
      ],
    };
    await updateLayer(testAccountScope(), layer.id, {
      style: { ...layer.style, fill },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const stored = requireLayer(testAccountScope(), layer.id);
    const before = JSON.stringify(stored.style);

    // StylePanel's open read: resolve fields, fetch the ramp distribution,
    // and project the stored paint into PaintControls' display state.
    const fields = await layerFields(testAccountScope(), stored);
    await layerFieldStats(testAccountScope(), stored, fill.attribute);
    const opened = paintControlsOpenState(stored.style.fill, fields.styling);

    expect(opened.method).toBe("quantile");
    expect(opened.legend?.entries.map((entry) => entry.color)).toEqual(
      fill.colors,
    );
    expect(JSON.stringify(requireLayer(testAccountScope(), layer.id).style)).toBe(before);
  });
});
