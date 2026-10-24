/**
 * The people marks' words, worked out from what the reads say and nothing
 * else: an item's owner, a project's owner and the reader's role on it, and
 * a project's people as its owner reads them. "Shared" on these surfaces
 * means people; a dataset filed in several projects keeps its own "also in"
 * wording elsewhere.
 */

/** A person as the reads name them: display name, SQL name and, while
 * they have a picture, its version for their face; never more. */
export interface PersonLabel {
  name: string;
  sqlName: string;
  pictureVersion?: string;
}

export type ProjectRole = "owner" | "editor" | "viewer";

/** One of a project's people, as its people read answers. */
export interface ProjectPersonWire extends PersonLabel {
  role: ProjectRole;
  deactivated: boolean;
}

/** The letters a person's mark carries: the first letter of the first and
 * of the last word of the name, one letter for a one-word name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  if (words.length === 1) return first.toUpperCase();
  const last = Array.from(words[words.length - 1])[0] ?? "";
  return (first + last).toUpperCase();
}

/** The name a mark speaks of a person by: the first word of their name. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function roleWord(role: ProjectRole): string {
  return role === "owner" ? "Owner" : role === "editor" ? "Editor" : "Viewer";
}

/** "Shared with Bo", "Shared with Bo and Cy", "Shared with Bo, Cy and Dee". */
export function sharedWithLine(names: string[]): string {
  const firsts = names.map(firstName);
  if (firsts.length <= 1) return `Shared with ${firsts.join("")}`;
  return `Shared with ${firsts.slice(0, -1).join(", ")} and ${firsts[firsts.length - 1]}`;
}

/** Whether an item is someone else's: its owner is named and is not the
 * signed-in person. An unknown reader or an unnamed owner marks nothing. */
export function ownedByOther(
  owner: PersonLabel | null | undefined,
  me: string | null,
): owner is PersonLabel {
  return !!owner && me !== null && owner.sqlName !== me;
}

/** The project mark (the Projects page chip, the header path's project
 * segment): on a project one shares, how many people it is shared with; on
 * a project shared with one, whose it is and one's role. Nothing on a
 * project only its owner reaches, nor before its people have been read. */
export type PeopleMark =
  | { kind: "sharing"; count: number; title: string }
  | { kind: "shared"; owner: string; role: string }
  | null;

export function peopleMark(
  project: { role?: ProjectRole; owner?: PersonLabel },
  people: ProjectPersonWire[] | null | undefined,
): PeopleMark {
  if (project.role && project.role !== "owner") {
    if (!project.owner) return null;
    return {
      kind: "shared",
      owner: firstName(project.owner.name),
      role: roleWord(project.role),
    };
  }
  const members = (people ?? []).filter((p) => p.role !== "owner");
  if (members.length === 0) return null;
  return {
    kind: "sharing",
    count: members.length,
    title: sharedWithLine(members.map((p) => p.name)),
  };
}
