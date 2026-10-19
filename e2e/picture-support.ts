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
