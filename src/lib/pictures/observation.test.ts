import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { afterAll, expect, it } from "vitest";
import { isolatePictureData } from "@/lib/test-support/picture-data";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { closeMetadataDb } from "@/lib/metadata/db";
import { renderMapImage } from "@/lib/export/render-image";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { cardDefinition } from "./card";
import { pictureTarget, publishPicture } from "./publication";
import { requestPicture } from "./state";
isolatePictureData();
afterAll(closeMetadataDb);
it("observes admitted work and a committed set, never a refused publication", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Observed");
  const seen: { kind: string; mapId: string; monotonicMs: number }[] = [];
  const observe = (message: unknown) => seen.push(message as typeof seen[number]);
  subscribe("dezfil.picture.measure", observe);
  try {
    await renderMapImage(scope, { mapId: map.id, background: true, baseUrl: "http://fixture.test", credential: "fixture",
      definition: cardDefinition(map.viewport, "light"), driver: { launch: async () => ({ render: async () => ({ png: new Uint8Array([1]) }), close: async () => {}, kill: () => {} }) } });
    expect(seen.map(event => event.kind)).toEqual(["admitted"]);
    const target = pictureTarget(scope, map.id), state = requestPicture(map.id, target.digest, Date.now());
    await publishPicture(scope, target, state.requestedGeneration, { light: Buffer.from("light"), dark: Buffer.from("dark") }, NO_INPUTS);
    expect(seen.map(event => event.kind)).toEqual(["admitted", "published"]);
    expect(seen[1].monotonicMs).toBeGreaterThan(seen[0].monotonicMs);
    requestPicture(map.id, target.digest, Date.now(), true);
    await expect(publishPicture(scope, target, state.requestedGeneration, { light: Buffer.from("old"), dark: Buffer.from("old") }, NO_INPUTS)).rejects.toThrow();
    expect(seen).toHaveLength(2);
  } finally { unsubscribe("dezfil.picture.measure", observe); }
});
