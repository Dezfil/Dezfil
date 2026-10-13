"use client";

import { useMemo } from "react";
import { IconFolder } from "../gallery-icons";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { Spinner } from "../Spinner";
import { useSignedInSqlName } from "../sharing/signed-in";
import { KindIcon } from "./ProjectPicture";
import type { CatalogueState } from "./home-read";
import { recentHeading, recentItems, type RecentItem } from "./recent-model";
import { RecentCard, RecentRow, RecentStateRow } from "./RecentList";
import styles from "./EmptyHome.module.css";

/**
 * The empty project: the plate that says so and starts new things, then
 * the recent card — the last touched things across the workspace, the
 * kind first on every row, an Add on each of one's own (a Move where a
 * filed map or workflow would leave its project), and the owner's pill on
 * someone else's, which is not one's to file. The card and its rows are
 * RecentList's filing form. Presentation only: the home owns the reads,
 * the creates and the filing.
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

      <RecentCard
        heading={recentHeading(instanceName)}
        hint={hasRows ? <>none of these is in {projectName}</> : null}
      >
        {catalogue.status === "pending" && (
          <RecentStateRow>
            <Spinner />
            <span>Loading recent items…</span>
          </RecentStateRow>
        )}
        {catalogue.status === "failed" && (
          <RecentStateRow>
            <ErrorNote message={catalogue.error} onRetry={onRetryCatalogue} />
          </RecentStateRow>
        )}
        {catalogue.status === "ready" && items.length === 0 && (
          <RecentStateRow none>Nothing recent yet.</RecentStateRow>
        )}
        {items.map((it) => (
          <RecentRow
            key={`${it.kind}-${it.id}`}
            item={it}
            groupOf={groupOf}
            form={{ kind: "filing", busyId, onAdd }}
          />
        ))}
      </RecentCard>
    </>
  );
}
