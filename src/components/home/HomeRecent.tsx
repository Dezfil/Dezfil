"use client";

import { RecentCard, RecentRow, RecentStateRow } from "../projects/RecentList";
import { recentHeading, type RecentItem } from "../projects/recent-model";
import { AsyncState } from "../ui/AsyncState";
import { ErrorNote } from "../ui/ErrorNote";
import type { HomeRecent, HomeRecentItem, ListRead } from "./home-model";
import styles from "./Home.module.css";

/**
 * Recent on Home: the list card the empty project home draws, headed by
 * the instance's name, its rows the opening form (each the link to its
 * item, with no Add or Move). It waits for the three lists, so its rows
 * never reorder as reads land; a kind that failed is said beside the
 * kinds that answered, with Try again. While the project names are
 * unknown a filed item's where line is withheld; when the projects read
 * failed, its note and Try again stand at the card's head, so the retry
 * is there with or without a row to run again. Nothing to list, no
 * section.
 */

/** The row as the shared row draws it: a withheld where line is drawn
 * as none, never as "not in a project". */
function shown(item: HomeRecentItem): RecentItem {
  return { ...item, where: item.where ?? [] } as RecentItem;
}

export function HomeRecentSection({
  recent,
  instanceName,
  groupOf,
  projectsFailure,
  retry,
  announcedElsewhere,
}: {
  recent: HomeRecent;
  instanceName: string | null;
  groupOf: (operation: string) => string | null;
  /** The projects read's failure and its Try again; null unless it
   * failed. */
  projectsFailure: { error: string; retry: () => void } | null;
  /** Try again for each of the three lists. */
  retry: Record<ListRead, () => void>;
  /** A read whose failure another note on the page announces (the
   * lead's): its note here stands without announcing it again. */
  announcedElsewhere: ListRead | null;
}) {
  if (recent.state === "absent") return null;
  if (recent.state === "pending") {
    return (
      <section className={styles.section} data-recent-place="pending">
        <AsyncState state={{ status: "pending" }} pendingLabel="Loading recent items…">
          {() => null}
        </AsyncState>
      </section>
    );
  }
  return (
    <section className={`${styles.section} ${styles.recent}`} data-recent-place="shown">
      <RecentCard heading={recentHeading(instanceName)} asHeading>
        {projectsFailure && (
          <RecentStateRow>
            <ErrorNote message={projectsFailure.error} onRetry={projectsFailure.retry} data-recent-projects-failure />
          </RecentStateRow>
        )}
        {recent.failed.map((failure) => (
          <RecentStateRow key={failure.read}>
            <ErrorNote
              message={failure.error}
              onRetry={retry[failure.read]}
              announce={failure.read !== announcedElsewhere}
              data-recent-failure={failure.read}
            />
          </RecentStateRow>
        ))}
        {recent.items.map((item) => (
          <RecentRow
            key={`${item.kind}-${item.id}`}
            item={shown(item)}
            groupOf={groupOf}
            form={{ kind: "opening" }}
            withholdWhere={item.where === null}
          />
        ))}
      </RecentCard>
    </section>
  );
}
