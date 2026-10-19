import { chromiumPath } from "@/lib/export/render-drive";
import { executableFound } from "@/lib/system/executable";

const key = Symbol.for("dezfil.picture-renderer-standing");
const host = process as typeof process & { [key]?: { failed: boolean } };
const standing = host[key] ??= { failed: false };
/** File presence plus the last observed launch refusal. Reading starts no
 * program and never clears a failure; only the service's next look does. */
export function pictureRendererAvailable(): boolean {
  return !standing.failed && executableFound(chromiumPath());
}
export function pictureRendererFailed(): void { standing.failed = true; }
export function retryPictureRenderer(): void { standing.failed = false; }
