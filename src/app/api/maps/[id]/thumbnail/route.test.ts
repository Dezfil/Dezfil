import { publishPictureFixture } from "@/lib/test-support/picture-fixture";
import { saveThumbnail } from "@/lib/map-thumbnails";
import { POST as duplicate } from "../duplicate/route";
import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, expect, it, vi } from "vitest";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { closeMetadataDb } from "@/lib/metadata/db";
import { documentFacts } from "@/lib/metadata/document-facts";
import { GET, PUT } from "./route";
import { asFirstRecipe, sizedPicture } from "@/lib/test-support/picture-sizes";
import { shareProject } from "@/lib/test-support/sharing";
import { removeProjectPerson } from "@/lib/metadata/project-people";
isolatePictureData(); afterAll(closeMetadataDb);
it.each(["", "?theme=light&cycle=old", "?revision=malformed"])("refuses the retired upload without reading or changing anything (%s)", async query => {
  const map = createMap(testAccountScope(), "Retired"), facts = documentFacts({ kind: "map", id: map.id });
  const request = testAccountRequest(new Request(`http://fixture.test/api/maps/${map.id}/thumbnail${query}`, { method: "PUT", body: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) }));
  const read = vi.spyOn(request, "body", "get");
  const response = await PUT(request, { params: Promise.resolve({ id: map.id }) });
  expect(response.status).toBe(410); expect((await response.json()).error.code).toBe("picture_upload_retired");
  expect(read).not.toHaveBeenCalled(); expect(documentFacts({ kind: "map", id: map.id })).toEqual(facts);
  expect((await GET(testAccountRequest(new Request(`http://fixture.test/api/maps/${map.id}/thumbnail`)), { params: Promise.resolve({ id: map.id }) })).status).toBe(404);
});

it("serves complete themes and copies them; legacy single files retain their fallback", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Themes");
  await publishPictureFixture(scope, map.id, Buffer.from("light"), Buffer.from("dark"));
  const copied = await duplicate(testAccountRequest(new Request("http://fixture.test", { method: "POST" })), { params: Promise.resolve({ id: map.id }) });
  const id = (await copied.json()).id;
  const read = async (mapId: string, query: string) => GET(testAccountRequest(new Request(`http://fixture.test/api/maps/${mapId}/thumbnail${query}`)), { params: Promise.resolve({ id: mapId }) });
  for (const theme of ["light", "dark"]) expect(await (await read(id, `?theme=${theme}`)).text()).toBe(theme);
  expect(await (await read(id, "")).text()).toBe("light");
  expect((await read(id, "?theme=blue")).status).toBe(400);
  await saveThumbnail(scope, map.id, Buffer.from("legacy"));
  for (const query of ["", "?theme=light", "?theme=dark"]) expect(await (await read(map.id, query)).text()).toBe("legacy");
});

const get = (mapId: string, query = "", headers: Record<string, string> = {}, account = "test-account") =>
  GET(testAccountRequest(new Request(`http://fixture.test/api/maps/${mapId}/thumbnail${query}`, { headers }), undefined, account), { params: Promise.resolve({ id: mapId }) });

it("answers a named shape and width with the kept size that fits, and the PNG when none is named", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Sizes");
  await publishPictureFixture(scope, map.id, sizedPicture("light"), sizedPicture("dark"));
  const cases: [string, string, string][] = [
    ["?shape=wide&width=1500", "image/webp", "light:card-1980"],
    ["?theme=dark&shape=card&width=800", "image/webp", "dark:card-1080"],
    ["?shape=wide", "image/webp", "light:card-2904"],
    ["?width=100", "image/webp", "light:card-360"],
    ["?width=99999", "image/webp", "light:card-2904"],
    ["", "image/png", "light:png"],
    ["?theme=dark", "image/png", "dark:png"],
  ];
  for (const [query, type, text] of cases) {
    const response = await get(map.id, query);
    expect(response.status, query).toBe(200);
    expect(response.headers.get("content-type"), query).toBe(type);
    expect(await response.text(), query).toBe(text);
  }
});

it("answers a picture made by the first sized recipe from its own sizes under each name", async () => {
  const scope = testAccountScope(), map = createMap(scope, "First recipe");
  await publishPictureFixture(scope, map.id, sizedPicture("light"), sizedPicture("dark"));
  asFirstRecipe(map.id);
  const cases: [string, string][] = [
    ["?shape=wide&width=1500", "first-light:wide-1656"],
    ["?shape=wide", "first-light:wide-3312"],
    ["?theme=dark&shape=card&width=2904", "first-dark:card-1980"],
    ["?width=700", "first-light:card-720"],
    ["", "light:png"],
  ];
  for (const [query, text] of cases) expect(await (await get(map.id, query)).text(), query).toBe(text);
});

it.each(["?width=0", "?width=-5", "?width=1.5", "?width=wide", "?width=", "?shape=square", "?shape=", "?shape=card&width=1e3"])("refuses a bad shape or width like a bad theme (%s), unkept", async query => {
  const scope = testAccountScope(), map = createMap(scope, "Refused");
  await publishPictureFixture(scope, map.id, sizedPicture("light"), sizedPicture("dark"));
  const response = await get(map.id, query);
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_request");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("answers an older picture's PNG whatever is named", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Older");
  await publishPictureFixture(scope, map.id, Buffer.from("light"), Buffer.from("dark"));
  for (const query of ["?shape=wide&width=2000", "?width=400", "?shape=card", "?theme=dark&shape=wide"]) {
    const response = await get(map.id, query);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe(query.includes("dark") ? "dark" : "light");
  }
});

it("tags each answer by its bytes and answers an unchanged picture without them, after the same serving checks", async () => {
  const owner = testAccountScope(undefined, "tagowner");
  testAccountScope(undefined, "tagviewer"); testAccountScope(undefined, "tagstranger");
  shareProject(owner.accountId, "tag-project", [["tagviewer", "viewer"]]);
  const map = createMap(owner, "Tagged", "tag-project");
  await publishPictureFixture(owner, map.id, sizedPicture("light"), sizedPicture("dark"));
  const first = await get(map.id, "?shape=wide&width=1500", {}, "tagviewer");
  const tag = first.headers.get("etag")!;
  expect(tag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  expect(first.headers.get("cache-control")).toBe("private, no-cache");
  for (const held of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
    const again = await get(map.id, "?shape=wide&width=1500", { "if-none-match": held }, "tagviewer");
    expect(again.status, held).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(await again.text()).toBe("");
  }
  // Another size, another theme or a stale tag is answered in full, each under its own tag.
  const other = await get(map.id, "?shape=card&width=800", { "if-none-match": tag }, "tagviewer");
  expect(other.status).toBe(200); expect(other.headers.get("etag")).not.toBe(tag);
  expect((await get(map.id, "?shape=wide&width=1500", { "if-none-match": '"stale"' }, "tagviewer")).status).toBe(200);
  // Another account on the same browser, holding the tag: refused, not confirmed.
  const stranger = await get(map.id, "?shape=wide&width=1500", { "if-none-match": tag }, "tagstranger");
  expect(stranger.status).toBe(404); expect(stranger.headers.get("cache-control")).toBe("private, no-store");
  // A reader who lost the map, holding the tag: refused, not confirmed.
  expect(removeProjectPerson(owner, "tag-project", "tagviewer").some(person => person.sqlName === "tagviewer")).toBe(false);
  const lost = await get(map.id, "?shape=wide&width=1500", { "if-none-match": tag }, "tagviewer");
  expect(lost.status).toBe(404); expect(lost.headers.get("cache-control")).toBe("private, no-store");
});
