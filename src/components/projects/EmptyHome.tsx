"use client";

import { useMemo } from "react";
import { LastChanged } from "../sharing/LastChanged";
import { formatRelativeTime } from "../api";
import { DataMotif, IconFolder, geometryFamilies } from "../gallery-icons";
import { MapStrip } from "../MapStrip";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { Spinner } from "../Spinner";
import { MoveIcon, PlusIcon } from "../ui/icons";
import { WorkflowThumb } from "../WorkflowThumb";
import { OwnerPill } from "../sharing/PeopleMarks";
import { useSignedInSqlName } from "../sharing/signed-in";
import { KindIcon } from "./ProjectPicture";
import type { CatalogueState } from "./home-read";
import {
  KIND_WORD,
  recentHeading,
  recentItems,
  whereLine,
  type RecentItem,
} from "./recent-model";
import gallery from "../gallery.module.css";
import styles from "./EmptyHome.module.css";

/**
 * The empty project: the plate that says so and starts new things, then
 * the recent card — the last touched things across the workspace, the
 * kind first on every row, an Add on each of one's own (a Move where a
 * filed map or workflow would leave its project), and the owner's pill on
 * someone else's, which is not one's to file. Presentation only: the home
 * owns the reads, the creates and the filing.
 */

export function EmptyHome({
  projectId,
  projectName,
  instanceName,
  catalogue,
  exclude,
  names,
  groupOf,
  busyId,
  creatingMap,
  onAdd,
  onNewMap,
  onNewWorkflow,
  onAddData,
  onRetryCatalogue,
}: {
  projectId: string;
  projectName: string;
  instanceName: string | null;
  catalogue: CatalogueState;
  exclude: { maps: Set<string>; workflows: Set<string>; tables: Set<string> };
  names: Map<string, string>;
  groupOf: (operation: string) => string | null;
  /** The row whose Add is in flight, if any. */
  busyId: string | null;
  /** New map in flight: the button waits, so a double press makes one. */
  creatingMap: boolean;
  onAdd: (item: RecentItem) => void;
  onNewMap: () => void;
  onNewWorkflow: () => void;
  onAddData: () => void;
  onRetryCatalogue: () => void;
}) {
  const me = useSignedInSqlName();
  const items = useMemo(
    () =>
      catalogue.status === "ready"
        ? recentItems({ ...catalogue.value, projectId, exclude, names, me })
        : [],
    [catalogue, projectId, exclude, names, me],
  );
  const hasRows = catalogue.status === "ready" && items.length > 0;

  return (
    <>
      <div className={styles.plate} data-empty-plate>
        <span className={styles.plateGlyph} aria-hidden>
          <IconFolder />
        </span>
        <b>This project is empty</b>
        <div className={styles.creates}>
          <Button onClick={onNewMap} busy={creatingMap}>
            <KindIcon kind="map" /> New map
          </Button>
          <Button onClick={onNewWorkflow}>
            <KindIcon kind="workflow" /> New workflow
          </Button>
          <Button onClick={onAddData}>
            <KindIcon kind="dataset" /> Add data
          </Button>
        </div>
      </div>

      <div className={`${gallery.listCard} ${styles.recentCard}`} data-recent>
        <div className={`${gallery.listHead} ${styles.recentHead}`}>
          <span data-recent-heading>{recentHeading(instanceName)}</span>
          {hasRows && (
            <i data-recent-hint>none of these is in {projectName}</i>
          )}
        </div>
        {catalogue.status === "pending" && (
          <div className={styles.stateRow}>
            <Spinner />
            <span>Reading the workspace…</span>
          </div>
        )}
        {catalogue.status === "failed" && (
          <div className={styles.stateRow}>
            <ErrorNote message={catalogue.error} onRetry={onRetryCatalogue} />
          </div>
        )}
        {catalogue.status === "ready" && items.length === 0 && (
          <div className={styles.stateRow} data-recent-none>
            Nothing recent yet.
          </div>
        )}
        {items.map((it) => {
          // A map or workflow filed elsewhere leaves that project when it
          // comes here (at most one project): the button says so; a
          // dataset, or anything unfiled, is added.
          const moves = it.kind !== "dataset" && it.where.length > 0;
          return (
          <div key={`${it.kind}-${it.id}`} className={styles.row} data-recent-row={it.kind}>
            <span className={styles.kindTile} aria-hidden>
              <KindIcon kind={it.kind} />
            </span>
            <span className={styles.kindWord} data-recent-kind>
              {KIND_WORD[it.kind]}
            </span>
            <span className={styles.pic}>
              {it.kind === "map" ? (
                <MapStrip map={it.map} />
              ) : it.kind === "workflow" ? (
                <WorkflowThumb steps={it.workflow.steps} groupOf={groupOf} compact />
              ) : (
                <DataMotif
                  kinds={geometryFamilies(it.table.geometryType, it.table.geometryColumn)}
                />
              )}
            </span>
            <span className={styles.text}>
              <span className={styles.nameLine}>
                <b className={it.kind === "dataset" ? styles.mono : undefined} data-recent-name>
                  {it.name}
                </b>
                {it.owner && <OwnerPill owner={it.owner} placement="inline" />}
              </span>
              <small data-recent-meta>
                <span data-recent-where>{whereLine(it.where)}</span>
                <i>·</i>
                {it.fact}
                <i>·</i>
                {it.kind === "dataset" ? formatRelativeTime(it.time) : <LastChanged value={it.kind === "map" ? it.map : it.workflow} />}
              </small>
            </span>
            {!it.owner && (
              <Button
                className={styles.add}
                aria-label={`${moves ? "Move" : "Add"} ${it.name}`}
                busy={busyId === it.id}
                disabled={busyId !== null}
                onClick={() => onAdd(it)}
                data-recent-action={moves ? "move" : "add"}
              >
                {moves ? <MoveIcon /> : <PlusIcon />} {moves ? "Move" : "Add"}
              </Button>
            )}
          </div>
          );
        })}
      </div>
    </>
  );
}
