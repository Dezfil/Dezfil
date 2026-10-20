import { expect, type APIRequestContext } from "@playwright/test";
export async function waitForPicture(api: APIRequestContext, mapId: string, previous?: string | null) {
  let found: { pictureState: string; pictureVersion: string; hasThumbnail: boolean } | undefined;
  await expect(async () => {
    const response = await api.get("/api/maps"); expect(response.status()).toBe(200);
    found = (await response.json()).find((row: { id: string }) => row.id === mapId);
    expect(found?.pictureState).toBe("current"); expect(found?.hasThumbnail).toBe(true);
    if (previous !== undefined) expect(found?.pictureVersion).not.toBe(previous);
  }).toPass({ timeout: 90000 });
  return found!;
}

/** A map's card picture as the maps listing gives it. */
export interface ListedPicture {
  pictureState: string;
  pictureVersion: string | null;
}

/** The map's card picture as the maps listing gives it. */
export async function listedPicture(api: APIRequestContext, mapId: string): Promise<ListedPicture> {
  const response = await api.get("/api/maps");
  expect(response.status()).toBe(200);
  const row = ((await response.json()) as ({ id: string } & ListedPicture)[]).find((m) => m.id === mapId);
  expect(row, "the map is listed").toBeDefined();
  return { pictureState: row!.pictureState, pictureVersion: row!.pictureVersion };
}

/** States in which the server has no more picture work for the map. */
const AT_REST = ["current", "unsupported", "unavailable"];

/** The server makes a map's card picture five quiet seconds after each
 * drawing change, on the map's own basemap, so its renderer fetches the
 * same basemap style an export does. An export's basemap traffic is its
 * own only while the map's picture is at rest: in a state with no work
 * left, and the same across two seconds, so a change just made has had
 * time to ask for its picture. Answers the picture as it rests; a caller
 * counting traffic compares it with `listedPicture` after the export. */
export async function pictureAtRest(api: APIRequestContext, mapId: string): Promise<ListedPicture> {
  let rest: ListedPicture | undefined;
  await expect(async () => {
    const first = await listedPicture(api, mapId);
    expect(AT_REST, `the map's picture is at rest, not ${first.pictureState}`).toContain(first.pictureState);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await listedPicture(api, mapId)).toEqual(first);
    rest = first;
  }).toPass({ timeout: 90_000 });
  return rest!;
}
