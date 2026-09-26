import type { MapWithLayers } from "@/lib/metadata/maps";

/**
 * The render page's declaration is bound to one revision of the map.
 * The page reads the map once, then each visible layer's data through
 * the layer render request, which reads the layer again on the server;
 * an edit landing between the two reads would draw the edit and declare
 * the earlier filters. So after the layer reads settle the page reads
 * the map once more and compares: the visible layers, in order, each at
 * the same revision. Agreement binds the reads in between to that
 * revision, a layer edited in between carrying a later one;
 * disagreement restarts the assembly from the newer read.
 */
export function boundToSnapshot(snapshot: MapWithLayers, confirming: MapWithLayers): boolean {
  return revision(snapshot) === revision(confirming);
}

function revision(map: MapWithLayers): string {
  return map.layers.filter((layer) => layer.visible).map((layer) => `${layer.id}@${layer.updatedAt}`).join("\n");
}
