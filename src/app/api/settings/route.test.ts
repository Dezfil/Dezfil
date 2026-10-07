import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { GET, PATCH } from "./route";
import { createFirstAccount } from "@/lib/auth/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";

let dir: string, secret: string;
const runDataDir = process.env.DEZFIL_DATA_DIR!;

beforeEach(async () => {
  dir = await mkdtemp(path.join(runDataDir, "settings-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  secret = (await createFirstAccount({ name: "Ada", email: "ada@example.test", password: "field notebooks at dawn" })).secret;
});

afterEach(async () => {
  closeMetadataDb();
  process.env.DEZFIL_DATA_DIR = runDataDir;
  await rm(dir, { recursive: true, force: true });
});

const patch = (body: unknown) =>
  PATCH(socketRequest(new Request("http://test/api/settings", { method: "PATCH", headers: {
    cookie: `dezfil_session=${secret}`, origin: "http://test", "content-type": "application/json",
  }, body: JSON.stringify(body) })));
const get = () => GET(socketRequest(new Request("http://test/api/settings", { headers: { cookie: `dezfil_session=${secret}` } })));
type Json = Record<string, unknown>;

describe("the instance name: optional, trimmed, null on the wire", () => {
  it("reads null before any name is set, never an omitted key", async () => {
    const read = (await (await get()).json()) as Json;
    expect(read).toHaveProperty("instanceName");
    expect(read.instanceName).toBeNull();
  });

  it("saves trimmed and persists across a fresh connection", async () => {
    const saved = await patch({ instanceName: "  Stadtwerke  " });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Json).instanceName).toBe("Stadtwerke");
    closeMetadataDb();
    const read = (await (await get()).json()) as Json;
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
    const read = (await (await get()).json()) as Json;
    expect(read.displayName).toBe("Ada Lovelace");
    expect(read.instanceName).toBe("Stadtwerke");
  });
});

describe("view preferences per screen (workflows)", () => {
  it("remembers the workflows list's view and sort, and reads them back", async () => {
    const saved = await patch({ viewPrefs: { workflows: { view: "list", sort: "created" } } });
    expect(saved.status).toBe(200);
    closeMetadataDb();
    const read = (await (await get()).json()) as Json;
    expect((read.viewPrefs as Json).workflows).toEqual({ view: "list", sort: "created" });
  });

  it("refuses a sort the workflows list does not have, and an unknown screen", async () => {
    expect((await patch({ viewPrefs: { workflows: { sort: "rows" } } })).status).toBe(400);
    expect((await patch({ viewPrefs: { workflows: { view: "tiles" } } })).status).toBe(400);
    // An unknown screen is ignored rather than stored: only the documented shape lands.
    const odd = await patch({ viewPrefs: { canvas: { view: "list" } } });
    expect(odd.status).toBe(200);
    const read = (await (await get()).json()) as Json;
    expect(read.viewPrefs as Json).not.toHaveProperty("canvas");
  });
});

describe("the look: six picks, read whole and written in part", () => {
  const TODAY = { color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover" };
  type Refusal = { error: { code: string; message: string } };

  it("reads every pick at its default for an account that never picked", async () => {
    const read = (await (await get()).json()) as Json;
    expect(read.look).toEqual(TODAY);
  });

  it("reports a written choice back, keeps it across a reopened store and merges a later pick beside it", async () => {
    const saved = await patch({ look: { color: "harbor", rail: "icons" } });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Json).look).toEqual({ ...TODAY, color: "harbor", rail: "icons" });
    closeMetadataDb();
    expect(((await (await get()).json()) as Json).look).toEqual({ ...TODAY, color: "harbor", rail: "icons" });
    const merged = await patch({ look: { corners: "soft" } });
    expect(((await merged.json()) as Json).look).toEqual({ ...TODAY, color: "harbor", rail: "icons", corners: "soft" });
    // The default itself is a choice like any other: writing it back is how a pick returns.
    expect(((await (await patch({ look: { color: "kelp" } })).json()) as Json).look).toEqual({ ...TODAY, rail: "icons", corners: "soft" });
  });

  it.each([
    ["a value outside the pick's choices, naming the key", { color: "teal" }, "look.color: Expected one of: kelp, harbor, heather, slate."],
    ["a null value, naming the key", { rail: null }, "look.rail: Expected one of: hover, open, icons."],
    ["an unknown key inside the slice, by its position", { glow: "on" },
      "look: Unknown setting at position 2. Expected one of: color, contrast, font, background, corners, rail."],
  ])("refuses %s, and stores nothing of a body that also changes the grouping", async (_label, look, message) => {
    expect((await patch({ look: { contrast: "more" } })).status).toBe(200);
    const before = await (await get()).json();
    const refused = await patch({ sourceGrouping: "project", look: { font: "system", ...look } });
    expect(refused.status).toBe(400);
    expect((await refused.json()) as Refusal).toEqual({ error: { code: "invalid_request", message } });
    expect(await (await get()).json()).toEqual(before);
  });

  it("never repeats an unknown key's text, which may hold a credential, while a bad value still names its pick", async () => {
    const key = "sk-live-7Qx2Rv9TzKp4", value = "hunter2-on-the-wire";
    const refused = await patch({ look: { color: "teal", [key]: value } });
    expect(refused.status).toBe(400);
    const { message } = ((await refused.json()) as Refusal).error;
    expect(message).toBe("look.color: Expected one of: kelp, harbor, heather, slate. "
      + "look: Unknown setting at position 2. Expected one of: color, contrast, font, background, corners, rail.");
    expect(message).not.toContain(key);
    expect(message).not.toContain("sk-live");
    expect(message).not.toContain(value);
  });

  it("names every failing key of the slice in one refusal", async () => {
    const refused = await patch({ look: { color: "teal", corners: "sharp" } });
    expect(((await refused.json()) as Refusal).error.message).toBe(
      "look.color: Expected one of: kelp, harbor, heather, slate. look.corners: Expected one of: rounded, soft.");
  });

  it.each([["a bare value", "harbor"], ["null", null], ["a list", ["harbor"]]])("refuses %s in place of the slice", async (_label, look) => {
    const refused = await patch({ sourceGrouping: "project", look });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as Refusal).error.message).toBe("look: Expected an object of look settings.");
    expect(((await (await get()).json()) as Json).sourceGrouping).toBe("person");
  });

  it("still ignores an unknown field outside the slice", async () => {
    const saved = await patch({ look: { background: "hex" }, glow: "on", viewPrefs: { canvas: { view: "list" } } });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as Json;
    expect(body).not.toHaveProperty("glow");
    expect(body.viewPrefs as Json).not.toHaveProperty("canvas");
    expect(body.look).toEqual({ ...TODAY, background: "hex" });
  });
});

describe("the Projects list's view preferences", () => {
  it("remembers the Projects list's view and sort and preserves a sibling slice", async () => {
    expect((await patch({ viewPrefs: { maps: { view: "list", sort: "name" } } })).status).toBe(200);
    const saved = await patch({ viewPrefs: { projects: { view: "list", sort: "largest" } } });
    expect(saved.status).toBe(200);
    const read = (await (await get()).json()) as Json;
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
