import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { parseInputs } from "@/lib/query/evaluation-inputs";
import { inThumbnailTurn, thumbnailMutationIds } from "./map-thumbnails";
async function names(folder: string): Promise<string[]> {
  try { return await readdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
/** Scan every owner's evidence before removing it. Unattributed foreign images
 * keep their existing residual; owned images need no evidence to be removed. */
export async function eraseThumbnailArtifacts(ownedMaps: readonly string[], datasets: readonly string[]): Promise<void> {
  const images = path.join(dataDir(), "thumbnails"), evidence = path.join(dataDir(), "artifact-inputs", "thumbnails");
  const all = [...await names(images), ...await names(evidence)];
  const maps = new Set([...ownedMaps, ...thumbnailMutationIds(), ...all.map(name => name.split(".")[0])]);
  await Promise.all([...maps].map(mapId => inThumbnailTurn(mapId, async () => {
    const owned = ownedMaps.includes(mapId), affected = new Set<string>();
    const recorded = (await names(evidence)).filter(name => name.startsWith(`${mapId}.`));
    for (const name of recorded) {
      if (owned) { affected.add(name.replace(/\.json(?:\..*\.tmp)?$/, "")); continue; }
      let input: unknown;
      try { input = JSON.parse(await readFile(path.join(evidence, name), "utf8")).inputs; }
      catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (parseInputs(input)?.datasets.some(d => datasets.includes(d.id))) affected.add(name.replace(/\.json(?:\..*\.tmp)?$/, ""));
    }
    for (const name of (await names(images)).filter(name => name.startsWith(`${mapId}.`))) {
      if (owned || affected.has(name) || affected.size > 0 && name === `${mapId}.json`) await rm(path.join(images, name), { force: true });
    }
    for (const name of recorded) if (owned || [...affected].some(image => name === `${image}.json` || name.startsWith(`${image}.json.`))) await rm(path.join(evidence, name), { force: true });
  })));
}
