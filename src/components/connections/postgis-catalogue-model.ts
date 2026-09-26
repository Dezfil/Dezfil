import {
  relationKey,
  type PostgisRemoteRelation,
} from "./postgis-pane-types";

export type PostgisRelationFilter = "all" | "spatial" | "attribute";

export interface PostgisSchemaGroup {
  schema: string;
  spatialCount: number;
  attributeCount: number;
  relations: PostgisRemoteRelation[];
}

export function isSpatial(relation: PostgisRemoteRelation): boolean {
  return relation.spatialKind !== null;
}

export function catalogueGroups(
  relations: PostgisRemoteRelation[],
  search: string,
  filter: PostgisRelationFilter,
): PostgisSchemaGroup[] {
  const query = search.trim().toLocaleLowerCase();
  const visible = relations.filter(
    (relation) =>
      (filter === "all" ||
        (filter === "spatial" ? isSpatial(relation) : !isSpatial(relation))) &&
      (!query || relationKey(relation).toLocaleLowerCase().includes(query)),
  );
  const schemas = [...new Set(visible.map((relation) => relation.schema))].sort(
    (left, right) =>
      left === right
        ? 0
        : left === "public"
          ? -1
          : right === "public"
            ? 1
            : left.localeCompare(right),
  );
  return schemas.map((schema) => {
    const grouped = visible
      .filter((relation) => relation.schema === schema)
      .sort(
        (left, right) =>
          Number(left.system) - Number(right.system) ||
          Number(!isSpatial(left)) - Number(!isSpatial(right)) ||
          left.table.localeCompare(right.table),
      );
    const spatialCount = grouped.filter(isSpatial).length;
    return {
      schema,
      spatialCount,
      attributeCount: grouped.length - spatialCount,
      relations: grouped,
    };
  });
}

export function groupIsClosed(
  closed: ReadonlySet<string>,
  schema: string,
  search: string,
): boolean {
  return closed.has(schema) && !search.trim();
}

export function relationKindLabel(relation: PostgisRemoteRelation): string {
  if (relation.kind === "materialized_view") return "mat. view";
  return relation.kind;
}

export function estimateLabel(relation: PostgisRemoteRelation): string {
  if (relation.kind === "view") return "";
  if (relation.approxRows === null || relation.approxRows === undefined) {
    return "not analyzed";
  }
  return `~${relation.approxRows.toLocaleString()} rows`;
}

export function spatialLabel(relation: PostgisRemoteRelation): string {
  if (!relation.spatialKind || !relation.geometryType) return "no geometry";
  return [
    relation.spatialKind,
    relation.geometryType,
    relation.srid ? String(relation.srid) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
