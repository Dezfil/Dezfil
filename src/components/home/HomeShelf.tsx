"use client";

import Link from "next/link";
import { IconOpen, IconTemplate } from "../gallery-icons";
import { TemplateCard } from "../templates/TemplateCard";
import type { Theme } from "../theme";
import { AsyncState } from "../ui/AsyncState";
import type { HomeShelf } from "./home-model";
import styles from "./Home.module.css";

/**
 * The templates below everything else: the Templates page's card as it
 * ships, with its Open and Make a copy, in a row of Home's own, under "What
 * Dezfil can do" with the count line when the person reaches nothing yet,
 * else "From the templates"; the link opens the Templates page. While the
 * list or the lead is still read, the shipped pending line; a failed list,
 * its note with Try again; no template beyond the lead, no section.
 */
export function HomeShelfSection({
  shelf,
  theme,
  groupOf,
  labelOf,
  onRetry,
  onOpen,
  onCopy,
}: {
  shelf: HomeShelf;
  theme: Theme;
  groupOf: (operation: string) => string | null;
  /** Operation id to its name; null until the catalogue of operations is
   * read. */
  labelOf: ((operation: string) => string) | null;
  /** Ask the template list again. */
  onRetry: () => void;
  onOpen: (id: string) => void;
  onCopy: (id: string) => void;
}) {
  if (shelf.state === "absent") return null;
  if (shelf.state === "pending" || shelf.state === "failed") {
    // No heading until the section's words are known.
    return (
      <section className={styles.section} data-shelf={shelf.state}>
        <AsyncState
          state={shelf.state === "failed" ? { status: "failed", error: shelf.error } : { status: "pending" }}
          onRetry={onRetry}
          pendingLabel="Reading the templates…"
        >
          {() => null}
        </AsyncState>
      </section>
    );
  }
  return (
    <section className={styles.section} data-shelf="shown">
      <div className={styles.secRow}>
        <span className={styles.secGlyph} aria-hidden>
          <IconTemplate />
        </span>
        <h2>{shelf.heading}</h2>
        {shelf.countLine && (
          <span className={styles.cnt} data-shelf-count>
            {shelf.countLine}
          </span>
        )}
        <Link href="/templates" className={styles.secLink} data-shelf-link>
          {shelf.link}
          <IconOpen />
        </Link>
      </div>
      <div className={styles.shelf}>
        {shelf.cards.map((card, i) => (
          <TemplateCard
            key={card.id}
            card={card}
            index={i}
            theme={theme}
            groupOf={groupOf}
            labelOf={labelOf}
            onOpen={() => onOpen(card.id)}
            onCopy={() => onCopy(card.id)}
          />
        ))}
      </div>
    </section>
  );
}
