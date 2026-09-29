import type { AccountScope } from "@/lib/auth/scope";
import { getOwnedLayer } from "@/lib/metadata/map-queries";

export function requireLayer(scope: AccountScope, id: string) {
  return getOwnedLayer(scope, id);
}
