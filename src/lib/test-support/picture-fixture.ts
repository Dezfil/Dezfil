import type { AccountScope } from "@/lib/auth/scope";
import { pictureWorkScope } from "@/lib/auth/scope";
import { boundedEvaluation } from "@/lib/query/bounded";
import { mapEvaluation } from "@/lib/query/context";
import { namedSql } from "@/lib/query/named-sql";
import { pictureBindings } from "@/lib/pictures/bindings";
import { requestPicture } from "@/lib/pictures/state";
import { publishPicture } from "@/lib/pictures/publication";
import { collectPictureEvaluation, readAttemptInputs } from "@/lib/pictures/inputs";
import { mintPictureCredential, revokePictureCredential } from "@/lib/pictures/credential";
/** Fixture pixels, real evaluated inputs and the whole-set publication road.
 * A caller may hold the returned attempt across a mutation to prove refusal. */
export async function preparePictureFixture(scope: AccountScope, mapId: string) {
  const { target } = await pictureBindings(scope, mapId);
  const state = requestPicture(mapId, target.digest, Date.now(), true);
  const credential = mintPictureCredential(mapId, Date.now() + 60000);
  try {
    const work = pictureWorkScope(credential).scope;
    const layers = target.map.layers.filter(layer => layer.visible);
    for (const layer of layers) await collectPictureEvaluation(work, layer.id, () => boundedEvaluation(async conn => { await conn.runAndReadAll(await namedSql(conn, layer.sql)); }, { scope: mapEvaluation(work, mapId) }));
    const inputs = readAttemptInputs(credential, layers.map(layer => layer.id));
    return { target, state, inputs, publish: (light: Uint8Array, dark: Uint8Array = light) => publishPicture(scope, target, state.requestedGeneration, { light, ...(target.basemaps.dark ? { dark } : {}) }, inputs) };
  } finally { revokePictureCredential(credential); }
}
export async function publishPictureFixture(scope: AccountScope, mapId: string, light: Uint8Array, dark: Uint8Array = light) {
  const fixture = await preparePictureFixture(scope, mapId); await fixture.publish(light, dark); return fixture;
}
