import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { GET, PATCH } from "./route";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const patch = (body: unknown) =>
  PATCH(new Request("http://test/api/settings", { method: "PATCH", body: JSON.stringify(body) }));
type Json = Record<string, unknown>;

describe("the instance name: optional, trimmed, null on the wire", () => {
  it("reads null before any name is set, never an omitted key", async () => {
    const read = (await (await GET()).json()) as Json;
    expect(read).toHaveProperty("instanceName");
    expect(read.instanceName).toBeNull();
  });

  it("saves trimmed and persists across a fresh connection", async () => {
    const saved = await patch({ instanceName: "  Stadtwerke  " });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Json).instanceName).toBe("Stadtwerke");
    closeMetadataDb();
    const read = (await (await GET()).json()) as Json;
    expect(read.instanceName).toBe("Stadtwerke");
  });

  it("clears on empty, on whitespace, and on explicit null", async () => {
    for (const clearing of ["", "   ", null]) {
      await patch({ instanceName: "Stadtwerke" });
      const cleared = await patch({ instanceName: clearing });
      expect(cleared.status).toBe(200);
      expect(((await cleared.json()) as Json).instanceName).toBeNull();
    }
  });

  it("refuses a name over the bound and a non-string value", async () => {
    expect((await patch({ instanceName: "x".repeat(81) })).status).toBe(400);
    expect((await patch({ instanceName: 7 })).status).toBe(400);
    // The bound itself fits.
    expect((await patch({ instanceName: "x".repeat(80) })).status).toBe(200);
  });

  it("leaves the display name alone on an instance-only patch", async () => {
    await patch({ displayName: "Ada Lovelace" });
    await patch({ instanceName: "Stadtwerke" });
    const read = (await (await GET()).json()) as Json;
    expect(read.displayName).toBe("Ada Lovelace");
    expect(read.instanceName).toBe("Stadtwerke");
  });
});

describe("view preferences per screen (workflows)", () => {
  it("remembers the workflows list's view and sort, and reads them back", async () => {
    const saved = await patch({ viewPrefs: { workflows: { view: "list", sort: "created" } } });
    expect(saved.status).toBe(200);
    const read = (await (await GET()).json()) as Json;
    expect((read.viewPrefs as Json).workflows).toEqual({ view: "list", sort: "created" });
  });

  it("refuses a sort the workflows list does not have, and an unknown screen", async () => {
    expect((await patch({ viewPrefs: { workflows: { sort: "rows" } } })).status).toBe(400);
    expect((await patch({ viewPrefs: { workflows: { view: "tiles" } } })).status).toBe(400);
    // An unknown screen is ignored rather than stored: only the documented shape lands.
    const odd = await patch({ viewPrefs: { canvas: { view: "list" } } });
    expect(odd.status).toBe(200);
    const read = (await (await GET()).json()) as Json;
    expect(read.viewPrefs as Json).not.toHaveProperty("canvas");
  });
});

describe("the Projects list's view preferences", () => {
  it("remembers the Projects list's view and sort and preserves a sibling slice", async () => {
    expect((await patch({ viewPrefs: { maps: { view: "list", sort: "name" } } })).status).toBe(200);
    const saved = await patch({ viewPrefs: { projects: { view: "list", sort: "largest" } } });
    expect(saved.status).toBe(200);
    const read = (await (await GET()).json()) as Json;
    expect((read.viewPrefs as Json).projects).toEqual({ view: "list", sort: "largest" });
    expect((read.viewPrefs as Json).maps).toEqual({ view: "list", sort: "name" });
  });

  it("refuses a sort the Projects list does not have, with the slices' sentence", async () => {
    const bad = await patch({ viewPrefs: { projects: { sort: "rows" } } });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      "viewPrefs.projects.sort must be one of updated, name, largest",
    );
    expect((await patch({ viewPrefs: { projects: { view: "tiles" } } })).status).toBe(400);
  });
});
