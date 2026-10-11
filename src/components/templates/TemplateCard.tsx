"use client";

import { useState } from "react";
import type { TemplateCard as Card } from "@/lib/templates/card";
import { IconDownload, IconDuplicate, IconOpen, MapPlaceholder } from "../gallery-icons";
import gallery from "../gallery.module.css";
import type { Theme } from "../theme";
import { WorkflowThumb } from "../WorkflowThumb";
import styles from "./Templates.module.css";
import {
  absentLine,
  cardTags,
  creditInFull,
  creditLine,
  dataDateLabel,
  graphSteps,
  templatePictureAddress,
  toolsLine,
} from "./template-model";

/**
 * One template on the Templates page: the Maps gallery's card, its strip,
 * lift and corner actions, with the place where a map card counts its
 * layers, the data's date where it says when it changed, and the lines a
 * template adds under its name: the question, a workflow example's tools,
 * its tags, its credit and, for a version not on this server yet, what an
 * open downloads first.
 */
export function TemplateCard({
  card,
  index,
  theme,
  groupOf,
  labelOf,
  onOpen,
  onCopy,
}: {
  card: Card;
  /** Its place in the grid, for the rise-in's stagger. */
  index: number;
  theme: Theme;
  /** Operation id to its catalog group, for a node's hue. */
  groupOf: (operation: string) => string | null;
  /** Operation id to its name; null until the catalog is read. */
  labelOf: ((operation: string) => string) | null;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const date = dataDateLabel(card.dataDate);
  const absent = absentLine(card);
  const tools = card.steps && labelOf ? toolsLine(card.steps, labelOf) : null;
  return (
    <article
      className={gallery.card}
      data-template={card.id}
      style={{ animationDelay: `${Math.min(45 + index * 45, 380)}ms` }}
    >
      <div
        role="link"
        tabIndex={0}
        aria-label={`Open ${card.title}`}
        className={gallery.cardLink}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen();
        }}
      >
        <div className={gallery.strip} style={{ height: 148 }}>
          {card.steps ? (
            <WorkflowThumb steps={graphSteps(card.steps)} groupOf={groupOf} />
          ) : (
            <TemplatePicture card={card} theme={theme} />
          )}
          <span className={gallery.overlay}>
            <b data-field="place">{card.place}</b>
          </span>
        </div>
        <div className={gallery.cardBody}>
          <div className={gallery.cardTop}>
            <span className={gallery.cardName} data-field="title">
              {card.title}
            </span>
            {/* The hint says what the words do not, so the words are
                marked as not explaining it (the hint layer's rule). */}
            <span className={gallery.cardWhen} data-field="date" data-hint={`Data of ${date}`}>
              <span data-hint-ignore-text>{date}</span>
            </span>
          </div>
          <p className={styles.question} data-field="question">
            {card.question}
          </p>
          {tools && (
            <p className={styles.tools} data-field="tools">
              {tools}
            </p>
          )}
          <div className={`${gallery.cardChips} ${styles.tags}`} data-field="tags">
            {cardTags(card.tags).map((tag) => (
              <span key={tag} className={gallery.chip}>
                {tag}
              </span>
            ))}
          </div>
          <p className={styles.credit} data-field="credit" data-hint={creditInFull(card.sources)}>
            <span data-hint-ignore-text>{creditLine(card.sources)}</span>
          </p>
          {absent && (
            <p className={styles.absent} data-field="absent">
              <IconDownload />
              <span>{absent}</span>
            </p>
          )}
        </div>
      </div>
      <span className={gallery.acts}>
        <button
          type="button"
          data-hint="Open"
          aria-label={`Open ${card.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <IconOpen />
        </button>
        <button
          type="button"
          data-hint="Make a copy"
          aria-label={`Make a copy of ${card.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
        >
          <IconDuplicate />
        </button>
      </span>
    </article>
  );
}

/** A map template's picture in the viewer's theme over the chart-paper
 * placeholder, which shows alone when the server holds no picture or the
 * picture does not load. */
function TemplatePicture({ card, theme }: { card: Card; theme: Theme }) {
  const src = templatePictureAddress(card.id, card.version, theme);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <MapPlaceholder />
      {card.picture === "kept" && failed !== src && (
        // Same-origin PNG; next/image would only add an optimizer hop.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" onError={() => setFailed(src)} />
      )}
    </>
  );
}
