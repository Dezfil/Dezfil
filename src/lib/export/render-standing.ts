import { requireReachable } from "@/lib/auth/reach";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";

/**
 * A render's standing on its map: the account is still active and still
 * reaches the map. Asked at every phase of a server render or a look check;
 * a map withdrawn from the caller while the render waits or works is refused
 * as absent, and nothing is returned or retained.
 */
export function requireRenderStanding(scope: AccountScope, mapId: string): void {
  requireAccountScope(scope);
  requireReachable(scope, "map", mapId);
}
