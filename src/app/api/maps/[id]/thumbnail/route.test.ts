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
