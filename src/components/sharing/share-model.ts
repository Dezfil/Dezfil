import { firstName, type PersonLabel, type ProjectPersonWire } from "./people";

/**
 * The share dialog's words and orderings, worked out from the project's
 * people, its contents and the directory's answers, and nothing else. Pure,
 * so the dialog and the head's members line say the same things.
 */

export type MemberRole = "viewer" | "editor";

/** The project's people in the dialog's order: its owner pinned first, then
 * the active members by name, then the deactivated ones. */
export function orderedPeople(people: readonly ProjectPersonWire[]): ProjectPersonWire[] {
  const owner = people.filter((p) => p.role === "owner");
  const members = people
    .filter((p) => p.role !== "owner")
    .sort(
      (a, b) =>
        Number(a.deactivated) - Number(b.deactivated) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.sqlName.localeCompare(b.sqlName),
    );
  return [...owner, ...members];
}

/** The members a project can be handed to: active ones only. */
export function transferable(people: readonly ProjectPersonWire[]): ProjectPersonWire[] {
  return orderedPeople(people).filter((p) => p.role !== "owner" && !p.deactivated);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a person given access gets: everything in the project. */
export function everythingLine(counts: { maps: number; workflows: number; datasets: number }): string {
  const parts = [
    counts.maps ? plural(counts.maps, "map") : null,
    counts.workflows ? plural(counts.workflows, "workflow") : null,
    counts.datasets ? plural(counts.datasets, "dataset") : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0
    ? `People get everything in it: ${parts.join(", ")}.`
    : "People get everything you add to it.";
}

/** "Bo", "Bo and Cy", "Bo, Cy and Dee". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The head's members line on a project shared with people: "Shared with
 * Bo and Cy", the first two and how many more past three. */
export function membersLine(people: readonly ProjectPersonWire[]): string | null {
  const firsts = orderedPeople(people)
    .filter((p) => p.role !== "owner")
    .map((p) => firstName(p.name));
  if (firsts.length === 0) return null;
  return firsts.length > 3
    ? `Shared with ${firsts.slice(0, 2).join(", ")} and ${firsts.length - 2} more`
    : `Shared with ${listNames(firsts)}`;
}

/** The one sentence a search that finds nobody says, by what was typed. */
export function missLine(query: string): string {
  return query.includes("@") ? "No account with that email." : "No account with that name.";
}

/** Where the accounts come from, said once beside a miss. */
export const USERS_LINE = "An admin adds accounts on the Users page.";

/** How a role reads in a sentence. */
export function roleWithArticle(role: MemberRole): string {
  return role === "editor" ? "an Editor" : "a Viewer";
}

export function roleTitle(role: MemberRole): string {
  return role === "editor" ? "Editor" : "Viewer";
}

/** A dataset of the owner's, filed in the project, that refreshes through
 * one of the owner's database connections. */
export interface ConnectionBound {
  name: string;
  owner?: PersonLabel;
  source: string;
  sourceParams?: Record<string, unknown> | null;
}

/**
 * The quiet lines naming a connection-bound refresh: for each of the
 * owner's connections that a dataset in the project refreshes through, the
 * datasets it feeds. Connections are never shared, so only their owner can
 * refresh those datasets; that is the surprise the line names.
 */
export function connectionLines(
  tables: readonly ConnectionBound[],
  me: string | null,
): { connection: string; datasets: string[] }[] {
  const byConnection = new Map<string, string[]>();
  for (const t of tables) {
    if (t.source !== "postgis" || !t.owner || t.owner.sqlName !== me) continue;
    const connection = t.sourceParams?.connectionName;
    if (typeof connection !== "string" || connection === "") continue;
    byConnection.set(connection, [...(byConnection.get(connection) ?? []), t.name]);
  }
  return [...byConnection.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([connection, datasets]) => ({ connection, datasets: [...datasets].sort() }));
}
