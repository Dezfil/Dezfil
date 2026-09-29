import type { AccountScope } from "@/lib/auth/scope";
import { listLayers, type MapRecord, type MapWithLayers } from "@/lib/metadata/maps";
import { getOwnedMap } from "@/lib/metadata/map-queries";

export function requireMap(scope: AccountScope, id: string): MapRecord {
  return getOwnedMap(scope, id);
}

export function mapWithLayers(scope: AccountScope, id: string): MapWithLayers {
  const map = requireMap(scope, id);
  return { ...map, layers: listLayers(id) };
}
