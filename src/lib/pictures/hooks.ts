export interface PictureChange { mapId: string; inherited?: boolean; force?: boolean }
const key = Symbol.for("dezfil.picture-changes");
const host = process as typeof process & { [key]?: Set<(event: PictureChange) => void> };
const listeners = host[key] ??= new Set<(event: PictureChange) => void>();
export function observePictureChanges(listener: (event: PictureChange) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** A microtask runs after enclosing synchronous transactions have settled.
 * Consumers reread committed state; a rolled-back or deleted map is absent. */
export function notifyPicture(mapId: string, options: Omit<PictureChange, "mapId"> = {}): void {
  queueMicrotask(() => { for (const listener of listeners) listener({ mapId, ...options }); });
}

const dataKey = Symbol.for("dezfil.picture-data-changes");
const dataHost = process as typeof process & { [dataKey]?: Set<(datasetId: string) => void> };
const dataListeners = dataHost[dataKey] ??= new Set<(datasetId: string) => void>();
export function observePictureDataChanges(listener: (datasetId: string) => void): () => void {
  dataListeners.add(listener); return () => { dataListeners.delete(listener); };
}
export function notifyPictureData(datasetId: string): void {
  queueMicrotask(() => { for (const listener of dataListeners) listener(datasetId); });
}
