"use client";

import { PeopleIcon } from "../ui/icons";
import { initials, ownedByOther, roleWord, type PeopleMark, type PersonLabel, type ProjectRole } from "./people";
import { useSignedInSqlName } from "./signed-in";
import gallery from "../gallery.module.css";
import styles from "./PeopleMarks.module.css";

/**
 * The people marks. The project chip sits beside the published chip on the
 * Projects page and on the header path's project segment; the owner pill
 * sits in the corner of a list item someone else owns; the role line sits
 * under a shared project's name on its home. Each only presents what its
 * caller worked out from the reads.
 */

/** The project chip: the people glyph with a count on a project one
 * shares, the owner and one's role on a project shared with one. */
export function PeopleChip({ mark }: { mark: PeopleMark }) {
  if (!mark) return null;
  if (mark.kind === "shared") {
    return (
      <span className={`${gallery.chip} ${styles.peopleChip}`} data-people="shared">
        <PeopleIcon />
        by {mark.owner} · {mark.role}
      </span>
    );
  }
  // The count alone is the face; who it counts is the hover's.
  return (
    <span
      className={`${gallery.chip} ${styles.peopleChip}`}
      data-people="sharing"
      data-hint={mark.title}
      role="img"
      aria-label={mark.title}
    >
      <PeopleIcon />
      <span data-hint-ignore-text>{mark.count}</span>
    </span>
  );
}

/** The corner pill on someone else's map, workflow or dataset: the people
 * glyph and the owner's initials, the owner's name on hover. In a list row
 * it stands in the name cell instead of over the picture, and on an opened
 * item beside its name in the header path. */
export function OwnerPill({
  owner,
  placement,
}: {
  owner: PersonLabel;
  placement: "corner" | "inline" | "path";
}) {
  return (
    <span
      className={styles.ownerPill}
      data-placement={placement}
      data-owner-pill={owner.sqlName}
      data-hint={`Shared by ${owner.name}`}
      role="img"
      aria-label={`Shared by ${owner.name}`}
    >
      <PeopleIcon />
      <span className={styles.initials} data-hint-ignore-text aria-hidden>
        {initials(owner.name)}
      </span>
    </span>
  );
}

/** The one quiet line under a shared project's name on its home: the
 * owner's initials, one's role, whose project it is. */
export function RoleLine({
  owner,
  role,
}: {
  owner: PersonLabel;
  role: Exclude<ProjectRole, "owner">;
}) {
  return (
    <div className={styles.roleLine} data-role-line={role}>
      <span className={styles.initials} aria-hidden>
        {initials(owner.name)}
      </span>
      <span>
        <b>{roleWord(role)}</b> · {owner.name}’s project
      </span>
    </div>
  );
}

/** An opened item's owner, beside its name in the header path's last
 * segment: the lists' pill when the item is someone else's, nothing on
 * one's own or while the signed-in person is unknown. A mark, never a
 * control. */
export function PathOwnerMark({ owner }: { owner?: PersonLabel | null }) {
  const me = useSignedInSqlName();
  return ownedByOther(owner, me) ? <OwnerPill owner={owner} placement="path" /> : null;
}
