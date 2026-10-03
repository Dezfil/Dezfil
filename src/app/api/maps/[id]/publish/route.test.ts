import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { withFixtureRevision } from "@/lib/test-support/edit-basis";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DELETE, GET, POST } from "./route";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { getPublishedTheme } from "@/lib/metadata/maps";

/**
 * The publish route's body contract: bodyless and empty requests stay
 * valid for existing callers; a stated theme is validated and captured;
 * garbage answers the documented invalid_request code.
 */

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

function post(id: string, body: string | undefined, revision: string | null | undefined) {
  return POST(
    testAccountRequest(new Request(`http://localhost/api/maps/${id}/publish`, {
      method: "POST", headers: revision ? { "X-Edit-Revision": revision } : {},
      ...(body === undefined ? {} : { body }),
    })),
    { params: Promise.resolve({ id }) },
  );
}

describe("publish route theme body", () => {
  it("a bodyless publish stays valid and records dark", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(map.id, undefined, readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(201);
    expect(getPublishedTheme(map.id)).toBe("dark");
  });

  it("a stated theme is captured", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(map.id, JSON.stringify({ theme: "light" }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(201);
    expect(getPublishedTheme(map.id)).toBe("light");
  });

  it("an invalid theme answers the documented invalid_request code", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(map.id, JSON.stringify({ theme: "sepia" }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(getPublishedTheme(map.id)).toBeNull();
  });

  it("a malformed body answers invalid_request, not a 500", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(map.id, "{not json", readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });
});

describe("publish route body strictness", () => {
  it("JSON null answers invalid_request, not a 500", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(map.id, "null", readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(getPublishedTheme(map.id)).toBeNull();
  });

  it("a primitive body answers invalid_request rather than silently publishing", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(map.id, JSON.stringify("light"), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(400);
    expect(getPublishedTheme(map.id)).toBeNull();
  });

  it("an explicit null theme answers invalid_request", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(map.id, JSON.stringify({ theme: null }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(400);
    expect(getPublishedTheme(map.id)).toBeNull();
  });
});

describe("publish route viewer controls", () => {
  const state = async (id: string) => {
    const res = await GET(
      testAccountRequest(new Request(`http://localhost/api/maps/${id}/publish`)),
      { params: Promise.resolve({ id }) },
    );
    return res.status === 204
      ? null
      : ((await res.json()) as {
          theme: string;
          viewerControls: Record<string, boolean>;
        });
  };

  it("an unpublished map has no publication to describe", async () => {
    const map = createMap(testAccountScope(), "m");
    expect(await state(map.id)).toBeNull();
  });

  it("a publication that states no set reports every control on", async () => {
    const map = createMap(testAccountScope(), "m");
    await post(map.id, undefined, readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect((await state(map.id))!.viewerControls).toEqual({
      tilt: true,
      fit: true,
      theme: true,
      basemap: true,
      coords: true,
    });
  });

  it("a stated set is captured, and its omitted members read on", async () => {
    const map = createMap(testAccountScope(), "m");
    await post(
      map.id,
      JSON.stringify({ viewerControls: { basemap: false, tilt: false } }),
     readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect((await state(map.id))!.viewerControls).toEqual({
      tilt: false,
      fit: true,
      theme: true,
      basemap: false,
      coords: true,
    });
  });

  it("the coordinate readout can be unchecked and stays unchecked", async () => {
    const map = createMap(testAccountScope(), "m");
    await post(map.id, JSON.stringify({ viewerControls: { coords: false } }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    const after = (await state(map.id))!.viewerControls;
    expect(after.coords).toBe(false);
    expect(after.basemap).toBe(true);
  });

  it("updates in place on an active publication without moving the token", async () => {
    const map = createMap(testAccountScope(), "m");
    const first = (await (await post(map.id, undefined, readEditRevision({ kind: "map", id: map.id })?.editRevision)).json()) as { token: string };
    const res = await post(
      map.id,
      JSON.stringify({ viewerControls: { fit: false } }),
     readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(((await res.json()) as { token: string }).token).toBe(first.token);
    expect((await state(map.id))!.viewerControls.fit).toBe(false);
  });

  // The load-bearing one: the builder's workspace-theme sync sends a theme
  // and nothing else, and must not re-enable what the author unchecked.
  it("a theme-only update leaves the checklist exactly as it was", async () => {
    const map = createMap(testAccountScope(), "m");
    await post(
      map.id,
      JSON.stringify({ theme: "light", viewerControls: { theme: false } }),
     readEditRevision({ kind: "map", id: map.id })?.editRevision);
    await post(map.id, JSON.stringify({ theme: "dark" }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    const after = (await state(map.id))!;
    expect(after.theme).toBe("dark");
    expect(after.viewerControls.theme).toBe(false);
  });

  it("a controls-only update leaves the authored theme alone", async () => {
    const map = createMap(testAccountScope(), "m");
    await post(map.id, JSON.stringify({ theme: "light" }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    await post(map.id, JSON.stringify({ viewerControls: { tilt: false } }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    const after = (await state(map.id))!;
    expect(after.theme).toBe("light");
    expect(after.viewerControls.tilt).toBe(false);
  });

  it("unpublishing clears the set with the token", async () => {
    const map = createMap(testAccountScope(), "m");
    await post(map.id, JSON.stringify({ viewerControls: { fit: false } }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    await DELETE(withFixtureRevision(testAccountRequest(new Request("http://localhost/x", { method: "DELETE" })), readEditRevision({ kind: "map", id: map.id })?.editRevision), {
      params: Promise.resolve({ id: map.id }),
    });
    expect(await state(map.id)).toBeNull();
    await post(map.id, undefined, readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect((await state(map.id))!.viewerControls.fit).toBe(true);
  });

  it("a non-boolean member answers invalid_request", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(
      map.id,
      JSON.stringify({ viewerControls: { fit: "yes" } }),
     readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(await state(map.id)).toBeNull();
  });

  it("an unknown member answers invalid_request rather than being ignored", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(
      map.id,
      JSON.stringify({ viewerControls: { zoom: false } }),
     readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(400);
  });

  it("a non-object controls field answers invalid_request", async () => {
    const map = createMap(testAccountScope(), "m");
    const res = await post(map.id, JSON.stringify({ viewerControls: true }), readEditRevision({ kind: "map", id: map.id })?.editRevision);
    expect(res.status).toBe(400);
  });
});
