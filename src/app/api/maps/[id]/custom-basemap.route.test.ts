import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap, redoChange, undoChange } from "@/lib/map-service";
import { PATCH } from "./route";
import type { StyleInspection } from "@/lib/net/inspect-style";

/**
 * The custom-basemap write at its route boundary: block vs force
 * semantics, the untouched key, clearing, and history. The inspector is
 * mocked — its own verdict mapping is unit-tested where it lives; these
 * tests own what the route does with a verdict.
 */

let inspection: StyleInspection;
vi.mock("@/lib/net/inspect-style", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/net/inspect-style")>()),
  inspectStyle: async () => inspection,
}));

let dir: string;
let mapId: string;

const patch = (body: unknown, basis: string) =>
  PATCH(
    testAccountRequest(new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Edit-Revision": basis },
      body: JSON.stringify(body),
    })),
    { params: Promise.resolve({ id: mapId }) },
  );

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  const map = createMap(testAccountScope(), "m");
  mapId = map.id;
  inspection = {
    verdict: "valid",
    name: "S",
    layerCount: 1,
    sourceCount: 1,
    attribution: [{ label: "© Somebody" }],
  };
});

afterEach(async () => {
  closeMetadataDb();
  await rm(dir, { recursive: true, force: true });
});

describe("custom basemap PATCH", () => {
  it("saves a valid style with its snapshot and leaves the key untouched", async () => {
    await patch({ basemap: "streets" }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    const res = await patch({
      customBasemap: { url: "https://x.test/s.json", name: "Company dark" },
    }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    expect(res.status).toBe(200);
    const map = (await res.json()) as {
      basemap: string;
      customBasemap: { url: string; name: string; attribution: unknown[] };
    };
    expect(map.basemap).toBe("streets");
    expect(map.customBasemap).toEqual({
      url: "https://x.test/s.json",
      name: "Company dark",
      attribution: [{ label: "© Somebody" }],
    });
  });

  it("clearing reveals the stored key; the record answers null", async () => {
    await patch({ basemap: "streets" }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    await patch({ customBasemap: { url: "https://x.test/s.json" } }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    const res = await patch({ customBasemap: null }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    const map = (await res.json()) as {
      basemap: string;
      customBasemap: unknown;
    };
    expect(map.customBasemap).toBeNull();
    expect(map.basemap).toBe("streets");
  });

  it("an unreachable style answers 400 without force and saves with it", async () => {
    inspection = { verdict: "unreachable", detail: "HTTP 404." };
    const blockedRes = await patch({
      customBasemap: { url: "https://gone.test/s.json" },
    }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    expect(blockedRes.status).toBe(400);
    const { error } = (await blockedRes.json()) as {
      error: { message: string };
    };
    expect(error.message).toContain("force: true");
    const forcedRes = await patch({
      customBasemap: { url: "https://gone.test/s.json", force: true },
    }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    expect(forcedRes.status).toBe(200);
    const map = (await forcedRes.json()) as {
      customBasemap: { attribution: { label: string }[] };
    };
    expect(map.customBasemap.attribution).toEqual([{ label: "gone.test" }]);
  });

  it("not-a-style answers 400 even forced", async () => {
    inspection = { verdict: "not_style", detail: "The response is not JSON." };
    const res = await patch({
      customBasemap: { url: "https://x.test/page.html", force: true },
    }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    expect(res.status).toBe(400);
  });

  it("the custom style rides history: undo removes it, redo restores it", async () => {
    // Two rapid same-field writes coalesce into one step by design, so
    // undo returns to the pre-custom state — exactly how the basemap
    // key behaves.
    await patch({ customBasemap: { url: "https://x.test/a.json" } }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    await patch({ customBasemap: { url: "https://x.test/b.json" } }, readEditRevision({ kind: "map", id: mapId })!.editRevision!);
    const undone = await undoChange(testAccountScope(), mapId);
    expect(undone.customBasemap).toBeNull();
    const redone = await redoChange(testAccountScope(), mapId);
    expect(redone.customBasemap?.url).toBe("https://x.test/b.json");
  });
});
