"use client";

import { useState } from "react";
import type { PgConnection } from "@/lib/metadata/connections";
import type { DataTable } from "@/components/api";
import { CaretIcon } from "@/components/ui/icons";
import { GeometryIcon, geometryKind } from "@/components/gallery-icons";
import {
  catalogueGroups,
  estimateLabel,
  groupIsClosed,
  type PostgisRelationFilter,
} from "./postgis-catalogue-model";
import { relationKey, type PostgisRemoteRelation } from "./postgis-pane-types";
import { PostgisRelationDetail } from "./PostgisRelationDetail";
import styles from "./PostgisPane.module.css";

export function PostgisCatalogue({
  connection,
  relations,
  onConnectionUsed,
  onTableCreated,
  projectId = null,
}: {
  connection: PgConnection;
  relations: PostgisRemoteRelation[];
  onConnectionUsed: (connectionId: string) => void;
  onTableCreated: (
    table: DataTable,
    relation: PostgisRemoteRelation,
    filter: string,
  ) => void | Promise<void>;
  /** The import's project context, passed through to the
   * relation detail that issues the request. */
  projectId?: string | null;
}) {
  const [selected, setSelected] = useState<PostgisRemoteRelation | null>(null);
  const [search, setSearch] = useState("");
  const [filterKind, setFilterKind] = useState<PostgisRelationFilter>("all");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const groups = catalogueGroups(relations, search, filterKind);

  const select = (relation: PostgisRemoteRelation) => {
    setSelected(relation);
  };

  return (
    <div className={styles.catalogueColumns}>
      <div className={styles.catalogueLeft}>
        <div className={styles.catalogueTools}>
          <input
            className={styles.search}
            type="search"
            aria-label="Search relations"
            placeholder="Search tables"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className={styles.segmented} role="group" aria-label="Relation kind">
            {(["all", "spatial", "attribute"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={filterKind === kind}
                onClick={() => setFilterKind(kind)}
              >
                {kind[0].toUpperCase() + kind.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.catalogueList}>
          {groups.length === 0 ? (
            <div className={styles.noMatches}>{search ? "Nothing matches." : "No relations in this filter."}</div>
          ) : null}
          {groups.map((group) => {
            const isClosed = groupIsClosed(closed, group.schema, search);
            return (
              <div className={styles.schemaGroup} key={group.schema}>
                <button
                  className={styles.schemaHead}
                  type="button"
                  aria-expanded={!isClosed}
                  onClick={() =>
                    setClosed((current) => {
                      const next = new Set(current);
                      if (next.has(group.schema)) next.delete(group.schema);
                      else next.add(group.schema);
                      return next;
                    })
                  }
                >
                  <span className={styles.schemaCaret}><CaretIcon /></span>
                  {group.schema}
                  <span className={styles.schemaCount}>
                    {group.spatialCount} spatial · {group.attributeCount} attribute
                  </span>
                </button>
                {!isClosed
                  ? group.relations.map((relation) => {
                      const active = selected && relationKey(selected) === relationKey(relation);
                      return (
                        <button
                          key={relationKey(relation)}
                          className={styles.relationRow}
                          data-active={active || undefined}
                          data-attribute={!relation.spatialKind || undefined}
                          type="button"
                          onClick={() => select(relation)}
                        >
                          <span className={styles.relationTile} data-attribute={!relation.spatialKind || undefined}>
                            <GeometryIcon kind={geometryKind(relation.geometryType, relation.geometryColumn)} />
                          </span>
                          <span className={styles.relationName}>
                            <span className={styles.relationLabel}>{relation.table}</span>
                          </span>
                          <span className={styles.relationRows} data-unknown={estimateLabel(relation) === "not analyzed" || undefined}>
                            {estimateLabel(relation)}
                          </span>
                        </button>
                      );
                    })
                  : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.catalogueDetail}>
        {selected ? (
          <PostgisRelationDetail
            key={relationKey(selected)}
            connection={connection}
            relation={selected}
            onConnectionUsed={onConnectionUsed}
            onTableCreated={onTableCreated}
            projectId={projectId}
          />
        ) : (
          <div className={styles.pickEmpty}>
            Pick a table to see its columns and a preview before you import it.
          </div>
        )}
      </div>
    </div>
  );
}
