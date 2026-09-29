import { ApiError } from "@/lib/api/errors";
import { getMap, listLayers, type MapRecord, type MapWithLayers } from "@/lib/metadata/maps";

export function requireMap(id: string): MapRecord {
  const map = getMap(id);
  if (!map) throw new ApiError("not_found", `No map with id ${id}.`, 404);
  return map;
}

export function mapWithLayers(id: string): MapWithLayers {
  const map = requireMap(id);
  return { ...map, layers: listLayers(id) };
}
