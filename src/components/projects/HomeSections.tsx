"use client";

import { LastChanged } from "../sharing/LastChanged";
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { MapOverview, TableListing } from "../api";
import { formatBytes, formatCompactCount, formatRelativeTime } from "../api";
import { DataMotif, geometryFamilies } from "../gallery-icons";
import { MapStrip } from "../MapStrip";
import { GeometryChip, SourceChip, geometryChipLabel } from "../table-chips";
import { nodeWord, type WorkflowListing } from "../workflow-model";
import { WorkflowStatusChip } from "../WorkflowStatusChip";
import { WorkflowThumb } from "../WorkflowThumb";
import { KindIcon } from "./ProjectPicture";
import { OwnerPill } from "../sharing/PeopleMarks";
import { ownedByOther, type PersonLabel } from "../sharing/people";
import { useSignedInSqlName } from "../sharing/signed-in";
import { datasetPageHref } from "../dataset-doors";
import { lastRunCell, otherMembershipNames } from "./home-model";
import { CardFrame, CardLink, MapCard, PublishedLink, WorkflowCard } from "./ItemCards";
import { PictureCredit } from "../PictureCredit";
import { readPictureListing } from "../picture-poll";
import { PicturePoll } from "../PicturePoll";
import type { PictureBasemaps } from "@/lib/picture-credit";
import gallery from "../gallery.module.css";
import styles from "./HomeSections.module.css";

/**
 * A project's sections: only the kinds with members, in the order Maps,
 * Workflows, Data, each headed by its kind mark, title and count. Cards
 * by default — the dataset card is the Data page's card in the home's
 * metric — and, on the page-wide switch, every section a list with its
 * own header row. Presentation only: the home owns the reads.
 */

export type HomeView = "cards" | "list";
export type LastRuns = Map<string, string | null | "unreadable">;

function ShareGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="17.5" cy="6" r="2.6" />
      <circle cx="17.5" cy="18" r="2.6" />
      <path d="m8.4 10.8 6.8-3.6M8.4 13.2l6.8 3.6" />
    </svg>
  );
}

const SECTION = {
  map: { title: "Maps" },
  workflow: { title: "Workflows" },
  dataset: { title: "Data" },
} as const;

/** A section's head: its kind mark, title and count. The destination
 * page 27 drew left with the lists' own project filter is the path to a
 * scoped list. */
function SectionHead({
  kind,
  count,
}: {
  kind: keyof typeof SECTION;
  count: number;
}) {
  return (
    <div className={styles.secRow}>
      <span className={styles.secGlyph} aria-hidden data-sec-mark={kind}>
        <KindIcon kind={kind} />
      </span>
      <h2>{SECTION[kind].title}</h2>
      <span className={styles.cnt}>{count}</span>
    </div>
  );
}

/** The Data page's card in the home's metric. */
function DatasetCard({
  table: t,
  others,
  owner,
}: {
  table: TableListing;
  others: string[];
  owner: PersonLabel | null;
}) {
  return (
    <CardFrame kind="dataset">
      <CardLink label={`Open ${t.name}`} href={datasetPageHref(t)}>
        <div className={gallery.strip} style={{ height: 112 }}>
          <DataMotif kinds={geometryFamilies(t.geometryType, t.geometryColumn)} />
          <span className={gallery.overlayData}>
            <b>{formatCompactCount(t.rowCount)}</b>{" "}
            <span className={gallery.cap}>
              rows ·{" "}
              <span className={gallery.num}>{formatBytes(t.sizeBytes)}</span>
            </span>
          </span>
        </div>
        <div className={gallery.cardBody}>
          <div className={gallery.cardTop}>
            <span className={gallery.cardName} title={t.name}>
              {t.name}
            </span>
            <span className={gallery.cardWhen}>
              {formatRelativeTime(t.importedAt ?? t.createdAt)}
            </span>
          </div>
          <div className={gallery.cardChips}>
            <SourceChip table={t} />
            <GeometryChip table={t} />
          </div>
          {others.length > 0 && (
            <span className={styles.sharedTag} data-also-in>
              <ShareGlyph />
              also in {others.join(", ")}
            </span>
          )}
        </div>
      </CardLink>
      {owner && <OwnerPill owner={owner} placement="corner" />}
    </CardFrame>
  );
}

export function HomeSections({
  projectId,
  maps,
  workflows,
  tables,
  names,
  lastRuns,
  view,
  groupOf,
  pictureBasemaps,
}: {
  projectId: string;
  maps: MapOverview[];
  workflows: WorkflowListing[];
  tables: TableListing[];
  /** Every project's name, for a shared dataset's other memberships. */
  names: Map<string, string>;
  lastRuns: LastRuns;
  view: HomeView;
  groupOf: (operation: string) => string | null;
  /** The instance's basemaps, which the line for the map pictures
   * credits. */
  pictureBasemaps?: PictureBasemaps;
}) {
  const router = useRouter();
  // Someone else's item in the project is marked with its owner.
  const me = useSignedInSqlName();
  const ownerOf = (item: { owner?: PersonLabel }) =>
    ownedByOther(item.owner, me) ? item.owner : null;
  const anyShared = tables.some(
    (t) => otherMembershipNames(t, projectId, names).length > 0,
  );
  // While a map here waits for its picture, the project's maps listing is
  // asked again for the pictures alone.
  const readProjectMaps = useCallback(
    () => readPictureListing(`/api/maps?project=${encodeURIComponent(projectId)}`),
    [projectId],
  );
  return (
    <PicturePoll cards={maps} read={readProjectMaps}>
      {maps.length > 0 && (
        <section className={styles.section} data-section="map">
          <SectionHead kind="map" count={maps.length} />
          {view === "cards" ? (
            <div className={styles.grid}>
              {maps.map((m) => (
                <MapCard key={m.id} map={m} owner={ownerOf(m)} />
              ))}
            </div>
          ) : (
            <div className={gallery.listCard}>
              <div className={gallery.listHead}>
                <span className={gallery.colThumb} />
                <span className={gallery.colName}>Name</span>
                <span className={gallery.colMeta}>Layers</span>
                <span className={gallery.colState}>Status</span>
                <span className={gallery.colWhen}>Last edited</span>
                <span className={styles.colAct} />
              </div>
              {maps.map((m) => (
                <div key={m.id} className={styles.rowWrap}>
                  <button
                    className={gallery.listRow}
                    onClick={() => router.push(`/maps/${m.id}`)}
                    aria-label={`Open ${m.name}`}
                  >
                    <span className={gallery.colThumb}>
                      <span className={styles.rowPic} data-row-pic>
                        <MapStrip map={m} />
                      </span>
                    </span>
                    <span className={gallery.colName}>
                      <span className={gallery.rowName}>{m.name}</span>
                      {ownerOf(m) && <OwnerPill owner={ownerOf(m)!} placement="inline" />}
                    </span>
                    <span className={gallery.colMeta}>
                      {m.layerCount} layer{m.layerCount === 1 ? "" : "s"}
                    </span>
                    <span className={gallery.colState}>
                      <span
                        className={gallery.chip}
                        data-live={m.published ? true : undefined}
                      >
                        <i />
                        {m.published ? "Published" : "Draft"}
                      </span>
                    </span>
                    <span className={gallery.colWhen}>
                      <LastChanged value={m} />
                    </span>
                    <span className={styles.colAct} />
                  </button>
                  {m.publishToken && (
                    <span className={styles.rowAct}>
                      <PublishedLink map={m} />
                    </span>
                  )}
                </div>
              ))}
              <PictureCredit maps={maps} basemaps={pictureBasemaps} placement="foot" />
            </div>
          )}
        </section>
      )}

      {workflows.length > 0 && (
        <section className={styles.section} data-section="workflow">
          <SectionHead kind="workflow" count={workflows.length} />
          {view === "cards" ? (
            <div className={styles.grid}>
              {workflows.map((w) => (
                <WorkflowCard
                  key={w.id}
                  workflow={w}
                  lastRun={lastRuns.get(w.id) ?? null}
                  groupOf={groupOf}
                  owner={ownerOf(w)}
                />
              ))}
            </div>
          ) : (
            <div className={gallery.listCard}>
              <div className={gallery.listHead}>
                <span className={gallery.colThumb} />
                <span className={gallery.colName}>Name</span>
                <span className={gallery.colMeta}>Nodes</span>
                <span className={gallery.colState}>Status</span>
                <span className={gallery.colWhen}>Last edited</span>
                <span className={gallery.colWhen}>Last run</span>
                <span className={styles.colAct} />
              </div>
              {workflows.map((w) => {
                const cell = lastRunCell(lastRuns.get(w.id) ?? null, formatRelativeTime);
                return (
                  <button
                    key={w.id}
                    className={gallery.listRow}
                    onClick={() => router.push(`/workflows/${w.id}`)}
                    aria-label={`Open ${w.name}`}
                  >
                    <span className={gallery.colThumb}>
                      <span className={styles.rowPic} data-row-pic>
                        <WorkflowThumb steps={w.steps} groupOf={groupOf} compact />
                      </span>
                    </span>
                    <span className={gallery.colName}>
                      <span className={gallery.rowName}>{w.name}</span>
                      {ownerOf(w) && <OwnerPill owner={ownerOf(w)!} placement="inline" />}
                    </span>
                    <span className={gallery.colMeta}>
                      {w.summary.nodes} {nodeWord(w.summary.nodes)}
                    </span>
                    <span className={gallery.colState}>
                      <WorkflowStatusChip summary={w.summary} />
                    </span>
                    <span className={gallery.colWhen}><LastChanged value={w} /></span>
                    <span className={gallery.colWhen} title={cell.title} data-last-run>
                      {cell.text}
                    </span>
                    <span className={styles.colAct} />
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tables.length > 0 && (
        <section className={styles.section} data-section="dataset">
          <SectionHead kind="dataset" count={tables.length} />
          {view === "cards" ? (
            <div className={styles.grid}>
              {tables.map((t) => (
                <DatasetCard
                  key={t.id}
                  table={t}
                  others={otherMembershipNames(t, projectId, names)}
                  owner={ownerOf(t)}
                />
              ))}
            </div>
          ) : (
            <div className={gallery.listCard}>
              <div className={gallery.listHead}>
                <span className={gallery.colThumb} />
                <span className={gallery.colName}>Name</span>
                <span className={styles.colSrc}>Source</span>
                <span className={styles.colGeom}>Geometry</span>
                <span className={styles.colRows}>Rows</span>
                <span className={styles.colSize}>Size</span>
                {anyShared && <span className={styles.colShared}>Also in</span>}
                <span className={gallery.colWhen}>Last updated</span>
                <span className={styles.colAct} />
              </div>
              {tables.map((t) => {
                const others = otherMembershipNames(t, projectId, names);
                return (
                  <button
                    key={t.id}
                    className={gallery.listRow}
                    onClick={() => router.push(datasetPageHref(t))}
                    aria-label={`Open ${t.name}`}
                  >
                    <span className={gallery.colThumb}>
                      <span className={styles.rowPic} data-row-pic>
                        <DataMotif
                          kinds={geometryFamilies(t.geometryType, t.geometryColumn)}
                        />
                      </span>
                    </span>
                    <span className={gallery.colName}>
                      <span className={styles.monoName}>{t.name}</span>
                      {ownerOf(t) && <OwnerPill owner={ownerOf(t)!} placement="inline" />}
                    </span>
                    <span className={styles.colSrc}>
                      <SourceChip table={t} />
                    </span>
                    <span className={styles.colGeom}>{geometryChipLabel(t)}</span>
                    <span className={styles.colRows}>
                      {t.rowCount.toLocaleString("en-US")}
                    </span>
                    <span className={styles.colSize}>{formatBytes(t.sizeBytes)}</span>
                    {anyShared && (
                      <span className={styles.colShared} data-also-in-cell>
                        {others.length > 0 && (
                          <>
                            <ShareGlyph />
                            <span className={styles.ellipsis}>{others.join(", ")}</span>
                          </>
                        )}
                      </span>
                    )}
                    <span className={gallery.colWhen}>
                      {formatRelativeTime(t.importedAt ?? t.createdAt)}
                    </span>
                    <span className={styles.colAct} />
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* The home's foot in cards; the list carries the line as the Maps
          list card's foot row. */}
      {view === "cards" && <PictureCredit maps={maps} basemaps={pictureBasemaps} placement="page" />}
    </PicturePoll>
  );
}
