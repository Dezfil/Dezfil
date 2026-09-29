import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { ingestFile } from "@/lib/ingest/ingest";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { publishMap, resetPublishCache } from "@/lib/publish/publish-service";
import { resetRateLimits } from "@/lib/publish/rate-limit";
import { removeTable } from "@/lib/table-service";
import { publishedMessage } from "@/lib/api/error-catalogue";
import type { MapWidget } from "@/lib/widgets";
import { POST } from "./route";

/**
 * The published settle lane at its route boundary: the reader's
 * selections re-render a computed layer under the published projection,
 * bounded to the fields the published surface declares, with hidden
 * layers answering exactly like absent ones.
 */

let dir: string;
let token: string;
let layerId: string;
let mapId: string;

const CATEGORY_WIDGET: Omit<MapWidget, "layerId"> = {
  id: "wc",
  type: "category",
  title: "By kind",
  field: "kind",
  agg: "count",
  aggField: null,
  unit: null,
  note: null,
  format: null,
  visible: true,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  resetRateLimits();
  const source = path.join(dir, "points.csv");
  await writeFile(
    source,
    "id,kind,score,lon,lat\n1,a,10,1,2\n2,b,20,3,4\n3,a,30,5,6\n",
  );
  await ingestFile(testAccountScope(), source, "points.csv");
  const map = createMap(testAccountScope(), "m");
  const layer = await createLayer(map.id, {
    name: "l",
    sql: "SELECT * FROM points",
  });
  layerId = layer.id;
  mapId = map.id;
  await updateLayer(layerId, {
    viz: { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } },
  });
  updateMap(map.id, {
    widgets: [{ ...CATEGORY_WIDGET, layerId: layer.id }],
  });
  token = publishMap(map.id).token;
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function settle(selections: unknown, layer = layerId) {
  return POST(
    new Request(`http://localhost/api/published/${token}/render/${layer}`, {
      method: "POST",
      body: JSON.stringify({ selections }),
    }),
    { params: Promise.resolve({ token, layerId: layer }) },
  );
}

describe("published settle route", () => {
  it("re-renders under a declared selection, cells carrying computed columns only", async () => {
    const res = await settle([
      { field: "kind", kind: "values", values: ["a"] },
    ]);
    expect(res.status).toBe(200);
    const render = (await res.json()) as {
      ok: boolean;
      geojson: { features: { properties: Record<string, unknown> }[] };
    };
    expect(render.ok).toBe(true);
    const total = render.geojson.features.reduce(
      (s, f) => s + Number(f.properties.count),
      0,
    );
    expect(total).toBe(2);
    for (const f of render.geojson.features) {
      expect(Object.keys(f.properties).sort()).toEqual([
        "__anchor",
        "count",
        "value",
      ]);
    }
  });

  it("refuses an undeclared field with the documented coded error", async () => {
    const res = await settle([
      { field: "score", kind: "range", min: 15, max: null },
    ]);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("field_not_published");
  });

  it("refuses kind-incompatible selections on declared fields before evaluation", async () => {
    // "kind" is declared via the published category widget — and is text.
    const timeOnText = await settle([
      { field: "kind", kind: "timerange", min: "2020-01-01T00:00:00", max: null },
    ]);
    expect(timeOnText.status).toBe(400);
    const timeBody = (await timeOnText.json()) as {
      error: { code: string; message: string };
    };
    expect(timeBody.error.code).toBe("selection_incompatible");
    expect(timeBody.error.message).toContain("time");
    expect(timeBody.error.message).not.toMatch(/LINE \d|Binder|Conversion/);

    const rangeOnText = await settle([
      { field: "kind", kind: "range", min: 0, max: 10 },
    ]);
    expect(rangeOnText.status).toBe(400);
    expect(
      ((await rangeOnText.json()) as { error: { code: string } }).error.code,
    ).toBe("selection_incompatible");
  });

  it("a range on a declared numeric field still evaluates", async () => {
    updateMap(mapId, {
      widgets: [
        { ...CATEGORY_WIDGET, layerId },
        {
          ...CATEGORY_WIDGET,
          id: "wh",
          type: "histogram",
          title: "Score",
          field: "score",
          agg: "count",
          layerId,
        },
      ],
    });
    const res = await settle([
      { field: "score", kind: "range", min: 15, max: null },
    ]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("a declared field the result no longer provides refuses cleanly, not with engine text", async () => {
    await updateLayer(layerId, { sql: "SELECT id, score, geometry FROM points" });
    const res = await settle([{ field: "kind", kind: "values", values: ["a"] }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("selection_incompatible");
    expect(body.error.message).toContain("no longer provides");
    expect(body.error.message).not.toMatch(/LINE \d|Binder|Catalog/);
  });

  it("coded pre-envelope refusals keep their documented authored copy — never engine text", async () => {
    // The published boundary's contract is documented copy on every
    // branch: errored envelopes substitute to the catalogue sentence;
    // coded refusals carry the documented message they were authored
    // with (the contract keeps refusal specifics reader-facing).
    const malformed = await POST(
      new Request(`http://localhost/api/published/${token}/render/${layerId}`, {
        method: "POST",
        body: "{not json",
      }),
      { params: Promise.resolve({ token, layerId }) },
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as {
      error: { code: string; message: string };
    };
    expect(malformedBody.error.code).toBe("invalid_request");
    expect(malformedBody.error.message).toBe("Expected a JSON body.");

    process.env.DEZFIL_PUBLIC_RATE_LIMIT = "1";
    try {
      await settle([]); // fills the 1-request window
      const limited = await settle([]);
      expect(limited.status).toBe(429);
      const limitedBody = (await limited.json()) as {
        error: { code: string; message: string };
      };
      expect(limitedBody.error.code).toBe("rate_limited");
      expect(limitedBody.error.message).toBe(
        "Too many requests. Please slow down.",
      );
      expect(JSON.stringify(limitedBody)).not.toMatch(
        /LINE \d|Binder|Catalog|\/data/,
      );
    } finally {
      delete process.env.DEZFIL_PUBLIC_RATE_LIMIT;
      resetRateLimits();
    }
  });

  it("an errored settle envelope carries the catalogue sentence, never engine text", async () => {
    await removeTable("points");
    const res = await settle([]);
    expect(res.status).toBe(200);
    const render = (await res.json()) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(render.ok).toBe(false);
    expect(render.error!.message).toBe(publishedMessage(render.error!.code));
    expect(JSON.stringify(render)).not.toMatch(
      /does not exist|Catalog|Binder|LINE \d/,
    );
  });

  it("answers a hidden layer exactly like an absent one", async () => {
    await updateLayer(layerId, { visible: false });
    const hidden = await settle([]);
    expect(hidden.status).toBe(404);
    expect((await hidden.json()).error.code).toBe("not_found");
    const absent = await settle([], "no-such-layer");
    expect(absent.status).toBe(404);
    expect((await absent.json()).error.code).toBe("not_found");
  });
});
