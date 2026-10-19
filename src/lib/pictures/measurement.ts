import { channel } from "node:diagnostics_channel";
const observation = channel("dezfil.picture.measure");
/** Process-local observation only; no rows, credentials or image bytes are
 * retained. The external proof subscriber owns its disposable event log. */
export function pictureMeasure(event: { kind: "admitted" | "released"; mapId: string; background: boolean } | { kind: "interrupted"; mapId: string } | { kind: "published"; mapId: string; generation: number }): void {
  if (observation.hasSubscribers) observation.publish({ ...event, at: Date.now(), monotonicMs: performance.now() });
}
