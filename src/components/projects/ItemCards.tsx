"use client";

import { LastChanged } from "../sharing/LastChanged";
import { useRouter } from "next/navigation";
import type { MapOverview } from "../api";
import { formatRelativeTime } from "../api";
import { IconOpen, MapPlaceholder } from "../gallery-icons";
import { MapStrip } from "../MapStrip";
import { nodeWord, sourceWord, type WorkflowListing } from "../workflow-model";
import { WorkflowStatusChip } from "../WorkflowStatusChip";
import { WorkflowThumb } from "../WorkflowThumb";
import { OwnerPill } from "../sharing/PeopleMarks";
import type { PersonLabel } from "../sharing/people";
import { lastRunLabel } from "./home-model";
import gallery from "../gallery.module.css";
import styles from "./ItemCards.module.css";

/**
 * A map's and a workflow's card as a project's home draws them: the card
 * is one link named for its item, someone else's carries its owner's pill
 * in the corner, and a published map its published view's link beside the
 * card. The card keeps its time on hover wherever it stands. Presentation
 * only: the host owns the reads.
 */

/** A card's frame: the gallery's card that keeps its time on hover. */
export function CardFrame({
  kind,
  children,
}: {
  kind: "map" | "workflow" | "dataset";
  children: React.ReactNode;
}) {
  return (
    <article className={`${gallery.card} ${styles.itemCard}`} data-sec-card={kind}>
      {children}
    </article>
  );
}

/** A card's link body: role=link, Enter opens (the shipped idiom). */
export function CardLink({
  label,
  href,
  children,
}: {
  label: string;
  href: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={label}
      className={gallery.cardLink}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter") router.push(href);
      }}
    >
      {children}
    </div>
  );
}

/** The picture's height a project's home draws; another host may draw it
 * taller. */
const STRIP_HEIGHT = 112;

export function MapCard({
  map: m,
  owner,
  stripHeight = STRIP_HEIGHT,
}: {
  map: MapOverview;
  owner: PersonLabel | null;
  stripHeight?: number;
}) {
  return (
    <CardFrame kind="map">
      <CardLink label={`Open ${m.name}`} href={`/maps/${m.id}`}>
        <div className={gallery.strip} style={{ height: stripHeight }} data-strip>
          <MapStrip map={m} />
          <span className={gallery.overlay}>
            <b>
              <span className={gallery.num}>{m.layerCount}</span>{" "}
              layer{m.layerCount === 1 ? "" : "s"}
            </b>
          </span>
        </div>
        <div className={gallery.cardBody}>
          <div className={gallery.cardTop}>
            <span className={gallery.cardName} title={m.name}>
              {m.name}
            </span>
            <span className={gallery.cardWhen}>
              <LastChanged value={m} />
            </span>
          </div>
          <div className={gallery.cardChips}>
            <span
              className={gallery.chip}
              data-live={m.published ? true : undefined}
            >
              <i />
              {m.published ? "Published" : "Draft"}
            </span>
          </div>
        </div>
      </CardLink>
      {owner && <OwnerPill owner={owner} placement="corner" />}
      {m.publishToken && (
        <div className={gallery.acts}>
          <PublishedLink map={m} />
        </div>
      )}
    </CardFrame>
  );
}

export function PublishedLink({ map: m }: { map: MapOverview }) {
  return (
    <a
      className={styles.pubAct}
      href={`/v/${m.publishToken}`}
      target="_blank"
      rel="noreferrer"
      data-hint="Open the published view"
      aria-label={`Open the published view of ${m.name}`}
      onClick={(e) => e.stopPropagation()}
    >
      <IconOpen />
    </a>
  );
}

export function WorkflowCard({
  workflow: w,
  lastRun,
  groupOf,
  owner,
  stripHeight = STRIP_HEIGHT,
}: {
  owner: PersonLabel | null;
  workflow: WorkflowListing;
  /** The newest run's start, null for none, "unreadable" when the history
   * could not be read, "pending" while it is being read: the glyph alone
   * until it answers, never "Never run". */
  lastRun: string | null | "unreadable" | "pending";
  groupOf: (operation: string) => string | null;
  stripHeight?: number;
}) {
  return (
    <CardFrame kind="workflow">
      <CardLink label={`Open ${w.name}`} href={`/workflows/${w.id}`}>
        <div className={gallery.strip} style={{ height: stripHeight }} data-strip>
          {/* No nodes, no graph to draw: the chart-paper placeholder an
              empty map's card shows, not a blank picture. */}
          {w.steps.length > 0 ? <WorkflowThumb steps={w.steps} groupOf={groupOf} /> : <MapPlaceholder />}
          <span className={gallery.overlay}>
            <b>
              <span className={gallery.num}>{w.summary.nodes}</span>{" "}
              {nodeWord(w.summary.nodes)}
              {w.summary.sources > 0 && (
                <>
                  {" · "}
                  <span className={gallery.num}>{w.summary.sources}</span>{" "}
                  {sourceWord(w.summary.sources)}
                </>
              )}
            </b>
          </span>
        </div>
        <div className={gallery.cardBody}>
          <div className={gallery.cardTop}>
            <span className={gallery.cardName} title={w.name}>
              {w.name}
            </span>
            <span className={gallery.cardWhen}><LastChanged value={w} /></span>
          </div>
          <div className={gallery.cardChips}>
            <WorkflowStatusChip summary={w.summary} />
            <span
              className={gallery.chip}
              title={
                lastRun === "unreadable"
                  ? "The run history couldn't be read"
                  : undefined
              }
            >
              {lastRunLabel(lastRun === "pending" ? "unreadable" : lastRun, formatRelativeTime)}
            </span>
          </div>
        </div>
      </CardLink>
      {owner && <OwnerPill owner={owner} placement="corner" />}
    </CardFrame>
  );
}
