"use client";

import { PeopleIcon } from "../ui/icons";
import { initials } from "./people";
import { membersLine, orderedPeople } from "./share-model";
import { useProjectPeople } from "./use-project-people";
import styles from "./MembersLine.module.css";

/**
 * The members line under a project's name on its owner's home: the faces
 * and "Shared with Bo and Cy" on a project shared with people, "Only you ·
 * Share" on one shared with nobody yet. Either way it is the dialog's door,
 * beside the head's Share action. Nothing until the people are read, so
 * the line never says "Only you" of a project that is shared.
 */
export function MembersLine({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const people = useProjectPeople([projectId]).get(projectId);
  if (!people) return null;
  const line = membersLine(people);
  if (line === null) {
    return (
      <button type="button" className={styles.members} data-none data-members-line="none" onClick={onOpen}>
        <PeopleIcon />
        <em>Only you</em>
        <em>·</em>
        <b>Share</b>
      </button>
    );
  }
  const others = orderedPeople(people).filter((p) => p.role !== "owner");
  return (
    <button type="button" className={styles.members} data-members-line="shared" onClick={onOpen}>
      <span className={styles.faces} aria-hidden>
        {others.slice(0, 3).map((p) => (
          <span key={p.sqlName} className={styles.face} data-off={p.deactivated || undefined}>
            {initials(p.name)}
          </span>
        ))}
      </span>
      <span>{line}</span>
    </button>
  );
}
