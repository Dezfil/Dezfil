export interface PostgisRemoteRelation {
  schema: string;
  table: string;
  kind: "table" | "view" | "materialized_view";
  system: boolean;
  geometryColumn: string | null;
  geometryType: string | null;
  srid: number | null;
  spatialKind: "geometry" | "geography" | null;
  approxRows?: number | null;
}

export function relationKey(relation: PostgisRemoteRelation): string {
  return `${relation.schema}.${relation.table}`;
}
