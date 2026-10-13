"use client";

import { useState } from "react";
import type { TemplateCard } from "@/lib/templates/card";
import { IconTemplate, MapPlaceholder } from "../gallery-icons";
import gallery from "../gallery.module.css";
import { MapCard, WorkflowCard } from "../projects/ItemCards";
import type { LastRun } from "../projects/run-history";
import {
  cardTags,
  creditInFull,
  creditLine,
  graphSteps,
  templatePictureAddress,
} from "../templates/template-model";
import { useTheme, type Theme } from "../theme";
import { AsyncState } from "../ui/AsyncState";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { DuplicateIcon, EyeIcon } from "../ui/icons";
import { WorkflowThumb } from "../WorkflowThumb";
import type { HomeLead } from "./home-model";
import styles from "./Home.module.css";

/**
 * The lead's place beside Start: the person's own last change as the card
 * a project's home draws for it, with a taller picture; else the first
 * template, wide; and while the maps and the workflows have not both
 * answered, the shipped pending line or failure note in its place, never
 * a lead chosen early. With neither lead, nothing.
 */

/** The lead's picture height, the Showroom reference's. */
const LEAD_PICTURE = 226;

export function LeadPlace({
  lead,
  lastRun,
  groupOf,
  onRetry,
  onRetryHistory,
  onOpenTemplate,
  onCopyTemplate,
}: {
  lead: HomeLead;
  /** The leading workflow's newest run, "pending" while it is read. */
  lastRun: LastRun | "pending";
  groupOf: (operation: string) => string | null;
  /** Ask the failed reads again. */
  onRetry: () => void;
  /** Read the leading workflow's run history again. */
  onRetryHistory: () => void;
  onOpenTemplate: (id: string) => void;
  onCopyTemplate: (id: string) => void;
}) {
  if (lead.kind === "none") return null;
  return (
    <section className={styles.section} data-lead={lead.kind}>
      {lead.kind === "continue" ? (
        <>
          <div className={styles.secRow}>
            <h2>Continue</h2>
          </div>
          {lead.item.kind === "map" ? (
            <MapCard map={lead.item.map} owner={lead.owner} stripHeight={LEAD_PICTURE} />
          ) : (
            <>
              <WorkflowCard
                workflow={lead.item.workflow}
                owner={lead.owner}
                lastRun={lastRun}
                groupOf={groupOf}
                stripHeight={LEAD_PICTURE}
              />
              {/* The card shows the glyph with its title; the retry stands
                  under it, since the card is one link. */}
              {lastRun === "unreadable" && (
                <ErrorNote
                  message="The run history couldn't be read."
                  onRetry={onRetryHistory}
                  data-lead-history-failure
                />
              )}
            </>
          )}
        </>
      ) : lead.kind === "template" ? (
        <>
          <div className={styles.secRow}>
            <h2>Start with a template</h2>
          </div>
          <TemplateLead
            card={lead.card}
            groupOf={groupOf}
            onOpen={() => onOpenTemplate(lead.card.id)}
            onCopy={() => onCopyTemplate(lead.card.id)}
          />
        </>
      ) : (
        <>
          {/* No heading until the lead is known: the row only keeps the
              place level with Start's. */}
          <div className={styles.secRow} aria-hidden />
          {/* The place keeps the card's height meanwhile, so Start beside
              it and everything below stay put when the card arrives. */}
          <div className={styles.leadHold} data-lead-hold>
            <AsyncState
              state={lead.kind === "failed" ? { status: "failed", error: lead.error } : { status: "pending" }}
              onRetry={onRetry}
            >
              {() => null}
            </AsyncState>
          </div>
        </>
      )}
    </section>
  );
}

/** The first template, drawn wide: its picture across the card (a
 * workflow example's graph), the Template mark where an owner's pill would
 * sit, the place and the sources' names, the title as the section's
 * largest line, the question, two tags, then Open and Make a copy. */
function TemplateLead({
  card,
  groupOf,
  onOpen,
  onCopy,
}: {
  card: TemplateCard;
  groupOf: (operation: string) => string | null;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const { theme } = useTheme();
  const sources = creditLine(card.sources);
  return (
    <article className={`${gallery.card} ${styles.leadCard}`} data-template={card.id}>
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
        <div className={gallery.strip} style={{ height: LEAD_PICTURE }}>
          {card.steps ? (
            <WorkflowThumb steps={graphSteps(card.steps)} groupOf={groupOf} />
          ) : (
            <LeadPicture card={card} theme={theme} />
          )}
        </div>
        <div className={styles.leadBody}>
          <p className={styles.leadMeta}>
            <span data-field="place">{card.place}</span>
            {sources && (
              <>
                {" · "}
                {/* The hint gives each source's credit and licence; the
                    names alone do not say them. */}
                <span data-field="sources" data-hint={creditInFull(card.sources)}>
                  <span data-hint-ignore-text>{sources}</span>
                </span>
              </>
            )}
          </p>
          <p className={styles.leadTitle} data-field="title">
            {card.title}
          </p>
          <p className={styles.leadQuestion} data-field="question">
            {card.question}
          </p>
          <div className={gallery.cardChips} data-field="tags">
            {cardTags(card.tags).map((tag) => (
              <span key={tag} className={gallery.chip}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>
      <span className={styles.mark} data-field="mark">
        <IconTemplate />
        Template
      </span>
      <div className={styles.leadActs}>
        <Button aria-label={`Open ${card.title}`} onClick={onOpen}>
          <EyeIcon />
          Open
        </Button>
        <Button variant="primary" aria-label={`Make a copy of ${card.title}`} onClick={onCopy}>
          <DuplicateIcon />
          Make a copy
        </Button>
      </div>
    </article>
  );
}

/** A map template's picture in the viewer's theme over the chart-paper
 * placeholder, which shows alone when the server holds no picture or the
 * picture does not load. */
function LeadPicture({ card, theme }: { card: TemplateCard; theme: Theme }) {
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
