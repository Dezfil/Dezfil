"use client";

import Link from "next/link";
import { PlusIcon } from "@/components/ui/icons";
import gallery from "@/components/gallery.module.css";

/**
 * The list pages' one heading: the page supplies its words and its
 * action; the arrangement is shared. No count stands beside the title
 * in any state — a field round over took the pill back off
 * the five pages, so the heading neither draws a number nor accepts
 * one. The pages still compute their totals, which the second line and
 * the filter chips need. The line is the page's second sentence and
 * appears only when it says something the title cannot; the page
 * decides that with headingLine.
 */
export type ListHeadingAction =
  | { label: string; onClick: () => void; disabled?: boolean }
  | { label: string; href: string };

export function ListHeading({
  title,
  line,
  note = null,
  action,
}: {
  title: string;
  line: string | null;
  /** Why the action is drawn disabled, when a rule holds it back. */
  note?: string | null;
  action: ListHeadingAction;
}) {
  return (
    <div className={gallery.heading} data-list-heading>
      <div>
        <h1>{title}</h1>
        {line && <p className={gallery.subLine}>{line}</p>}
        {note && <p className={gallery.subLine}>{note}</p>}
      </div>
      {"href" in action ? (
        <Link className={gallery.primary} href={action.href}>
          <PlusIcon /> {action.label}
        </Link>
      ) : (
        <button
          type="button"
          className={gallery.primary}
          onClick={action.onClick}
          disabled={action.disabled}
        >
          <PlusIcon /> {action.label}
        </button>
      )}
    </div>
  );
}
