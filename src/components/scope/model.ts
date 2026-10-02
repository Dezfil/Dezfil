/**
 * The project scope's shared model: the address vocabulary mirrors the
 * documented listing query — omission is All projects, `none` is Not in
 * a project, a non-empty identity is that project, and an empty value
 * stays invalid (it is sent through and refused, never silently
 * widened). Counts and the heading's second line derive here,
 * membership treated many-to-many with no preference.
 */

import { firstName } from "../sharing/people";

export type ProjectScope =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "project"; id: string }
  | { kind: "invalid" };

export function parseScope(raw: string | null): ProjectScope {
  if (raw === null) return { kind: "all" };
  if (raw === "") return { kind: "invalid" };
  if (raw === "none") return { kind: "none" };
  return { kind: "project", id: raw };
}

/** The address value to write; null removes the parameter (All). */
export function scopeParam(scope: ProjectScope): string | null {
  if (scope.kind === "none") return "none";
  if (scope.kind === "project") return scope.id;
  return null;
}

export interface ScopeRow {
  id: string; // "all" | "none" | a project id
  name: string;
  count: number;
  /** A project someone else owns and shares with the reader. */
  shared?: true;
  /** That project's owner, by first name. */
  owner?: string;
}

/** A project as the directory names it: the reader's role and the owner
 * arrive with every project the reader reaches. */
export interface ScopeProject {
  id: string;
  name: string;
  role?: "owner" | "editor" | "viewer";
  owner?: { name: string; sqlName: string };
}

/** The unset scope's row id. */
export const ALL_SCOPE = "all";

/** What a row prints beside its name, on the control's face and in its
 * menu: All projects prints nothing, whatever its value; every other
 * row prints its number, a count of zero and a count that happens to
 * equal the workspace total included. The distinction drawn in the field
 * is WHICH SCOPE IS SELECTED, so the rule reads the row's identity and
 * never its value. It lives here, on the model the control reads, so
 * the three lists and the add-layer catalog's two views inherit it
 * without a second edit. */
export function printedCount(row: {
  id: string;
  count: number | null;
}): number | null {
  return row.id === ALL_SCOPE ? null : row.count;
}

/** The popover's rows: All, the reader's own projects, the projects
 * shared with them (each with its owner's first name), and Not in a
 * project; zero counts included. `membershipOf` returns every project an
 * item is in; empty means unfiled. A dataset therefore counts in each of
 * its projects and as unfiled only with none. */
export function scopeRows<T>(
  items: T[],
  projects: ScopeProject[],
  membershipOf: (item: T) => string[],
): ScopeRow[] {
  const perProject = new Map<string, number>();
  let unfiled = 0;
  for (const item of items) {
    const memberships = membershipOf(item);
    if (memberships.length === 0) unfiled += 1;
    for (const id of memberships) {
      perProject.set(id, (perProject.get(id) ?? 0) + 1);
    }
  }
  const sharedWithReader = (p: ScopeProject) => !!p.role && p.role !== "owner";
  const row = (p: ScopeProject): ScopeRow => {
    const base = { id: p.id, name: p.name, count: perProject.get(p.id) ?? 0 };
    if (!sharedWithReader(p)) return base;
    const owner = p.owner ? firstName(p.owner.name) : null;
    return owner ? { ...base, shared: true, owner } : { ...base, shared: true };
  };
  return [
    { id: ALL_SCOPE, name: "All projects", count: items.length },
    ...projects.filter((p) => !sharedWithReader(p)).map(row),
    ...projects.filter(sharedWithReader).map(row),
    { id: "none", name: "Not in a project", count: unfiled },
  ];
}

/** The active row for the control's face; an invalid or unknown scope
 * has no row (the world is refusing) and reads as All for display.
 * Before the world resolves there are no rows: the face then carries
 * no count at all rather than asserting one. */
export function activeRow(
  rows: ScopeRow[],
  scope: ProjectScope,
): { id: string; name: string; count: number | null } {
  const id =
    scope.kind === "project"
      ? scope.id
      : scope.kind === "none"
        ? "none"
        : ALL_SCOPE;
  return (
    rows.find((r) => r.id === id) ??
    rows[0] ?? { id: ALL_SCOPE, name: "All projects", count: null }
  );
}

/** The heading's second line, the count line: it appears only when it says something the
 * title cannot. A search or filter that narrows the list says what is
 * shown of what, zero included; a scope names itself, an empty project
 * included ("0 in Berlin"); the two compose in the reference's order.
 * With no scope and no narrowing there is no line at all: took the
 * count pill off the title too, and removing the pill does not promote
 * the line to fill its place. */
export function headingLine(opts: {
  scopedTotal: number;
  scope: ProjectScope;
  scopeName: string | null;
  shownCount: number;
}): string | null {
  const { scopedTotal, scope, scopeName, shownCount } = opts;
  const where =
    scope.kind === "project"
      ? ` in ${scopeName ?? "this project"}`
      : scope.kind === "none"
        ? " not in a project"
        : "";
  if (shownCount !== scopedTotal) {
    return `${shownCount} of ${scopedTotal}${where} shown`;
  }
  return where ? `${scopedTotal}${where}` : null;
}

/** Projects the reader no longer reaches, said without a name: one's own
 * work stays filed in a project one was removed from until one takes it
 * out, and the directory, which lists what one reaches, has no name for it. */
export function unreachedProjects(count: number): string {
  return count === 1
    ? "a project you no longer reach"
    : `${count} projects you no longer reach`;
}

/** Membership identities as words: the names the directory knows,
 * alphabetical so order asserts nothing, then any it does not know as
 * projects the reader no longer reaches. */
export function membershipNames(
  ids: readonly string[],
  names: ReadonlyMap<string, string>,
): string[] {
  const named = ids
    .map((id) => names.get(id))
    .filter((n): n is string => typeof n === "string")
    .sort((a, b) => a.localeCompare(b));
  const unreached = new Set(ids.filter((id) => !names.has(id))).size;
  return unreached ? [...named, unreachedProjects(unreached)] : named;
}

/** The dataset row's Project cell: under a
 * named scope the scope itself is the context, so the cell names only the OTHER memberships ("also
 * in..."); elsewhere every membership is
 * a peer, alphabetical so order asserts nothing; none reads unfiled, and
 * only none: a membership the directory cannot name is a project the
 * reader no longer reaches. */
export function datasetProjectFact(
  projectIds: string[],
  scope: ProjectScope,
  names: Map<string, string>,
): { text: string; none: boolean } {
  // Identity is the ID: names are legitimately non-unique, so the
  // scope is excluded BY ID before any name resolves — a same-named
  // sibling membership must survive into the label.
  const nameOf = (ids: string[]) => membershipNames(ids, names);
  if (projectIds.length === 0) return { text: "not in a project", none: true };
  if (scope.kind === "project") {
    const others = nameOf(projectIds.filter((id) => id !== scope.id));
    return others.length
      ? { text: `also in ${others.join(", ")}`, none: false }
      : { text: "", none: false };
  }
  const named = nameOf(projectIds);
  if (named.length === 0) return { text: "not in a project", none: true };
  return { text: named.join(", "), none: false };
}

/** The New/Add tile's sub-line: the
 * scope the new object will take under a named or unfiled scope, else the
 * list's own unscoped sentence. One model for the three lists. */
export function tileSubLine(
  kind: "map" | "workflow" | "data",
  scope: ProjectScope,
  scopeName: string | null,
): string {
  if (scope.kind === "project") return `in ${scopeName ?? "this project"}`;
  if (scope.kind === "none") return "not in a project";
  if (kind === "map") return "Start from a blank map";
  if (kind === "workflow") return "Start from a blank canvas";
  return "Upload a file or import from a source";
}
