"use client";

import Link from "next/link";
import { PlusIcon } from "@/components/ui/icons";
import gallery from "@/components/gallery.module.css";

/**
 * The list pages' one heading: the page supplies its words and its
 * action, when it has one; the arrangement is shared. A page's total never
 * stands beside the title: the pages still compute their totals, which the
 * second line and the filter chips need. The one number the heading draws is
 * a limit's mark, "n of m", which a page passes only while the limit is set;
 * it stands outside the h1, so the heading's name stays the title. The line
 * is the page's second sentence and appears only when it says something the
 * title cannot; the page decides that with headingLine.
 */
export type ListHeadingAction =
  | { label: string; onClick: () => void; disabled?: boolean }
  | { label: string; href: string };

export function ListHeading({
  title,
  line,
  mark = null,
  note = null,
  action,
}: {
  title: string;
  line: string | null;
  /** Where the instance stands against a limit, while one is set. */
  mark?: string | null;
  /** Why the action is drawn disabled, when a rule holds it back. */
  note?: string | null;
  /** None on a page where nothing is made from the heading. */
  action?: ListHeadingAction;
}) {
  return (
    <div className={gallery.heading} data-list-heading>
      <div>
        <div className={gallery.titleLine}>
          <h1>{title}</h1>
          {mark && <span className={gallery.limitMark} data-limit-mark>{mark}</span>}
        </div>
        {line && <p className={gallery.subLine}>{line}</p>}
        {note && <p className={gallery.subLine}>{note}</p>}
      </div>
      {action === undefined ? null : "href" in action ? (
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
