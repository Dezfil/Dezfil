import type { TableListing } from "../api";
import { groupTables } from "../builder/drawer/derived-tables";
import type { RecipeSummary } from "../builder/drawer/recipe-model";
import type { PersonLabel } from "../sharing/people";

/**
 * The SQL console's source list, grouped. By person, the default: one's
 * own datasets as "Yours", then each other person's under their name and
 * SQL name. By project, the account's other choice: one group per project,
 * then "Not in a project", each row marked with its owner. Either way a
 * row reads as what one types in SQL: one's own by its plain name, someone
 * else's as `<sql name>.<name>`. While every listed dataset is one's own,
 * the person grouping has nobody to tell apart and keeps the list's shipped
 * groups (the tool outputs above the workspace's tables). Pure.
 */

export type SourceGrouping = "person" | "project";

export interface SourceRow {
  table: TableListing;
  /** The SQL name a typed reference carries, for someone else's dataset. */
  qualifier: string | null;
  /** The owner, whose face is shown by project. */
  owner: PersonLabel | null;
  /** The projects it reaches one through, named on hover by person. */
  via: string | null;
}

export interface SourceGroup {
  key: string;
  label: string;
  /** The person's SQL name beside their name, by person. */
  sqlName?: string;
  rows: SourceRow[];
}

const qualifierOf = (t: TableListing, me: string | null) =>
  me !== null && t.owner && t.owner.sqlName !== me ? t.owner.sqlName : null;

export function sourceGroups(
  tables: readonly TableListing[],
  options: {
    grouping: SourceGrouping;
    me: string | null;
    projects: readonly { id: string; name: string }[];
    recipes: RecipeSummary[];
  },
): SourceGroup[] {
  const { grouping, me, projects, recipes } = options;
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const via = (t: TableListing) => {
    const where = t.projectIds.map((id) => names.get(id)).filter((n): n is string => !!n);
    return where.length ? `In ${where.join(", ")}` : null;
  };
  const row = (t: TableListing): SourceRow => ({
    table: t,
    qualifier: qualifierOf(t, me),
    owner: t.owner ?? null,
    via: qualifierOf(t, me) ? via(t) : null,
  });

  if (grouping === "project") {
    const groups: SourceGroup[] = projects
      .map((p) => ({
        key: `project:${p.id}`,
        label: p.name,
        rows: tables.filter((t) => t.projectIds.includes(p.id)).map(row),
      }))
      .filter((g) => g.rows.length > 0);
    const loose = tables.filter((t) => t.projectIds.length === 0).map(row);
    if (loose.length) groups.push({ key: "none", label: "Not in a project", rows: loose });
    return groups;
  }

  const others = tables.filter((t) => qualifierOf(t, me) !== null);
  if (others.length === 0) {
    return groupTables([...tables], recipes).map((g) => ({
      key: g.key,
      label: g.label,
      rows: g.tables.map(({ table }) => row(table)),
    }));
  }
  const groups: SourceGroup[] = [];
  const mine = tables.filter((t) => qualifierOf(t, me) === null);
  if (mine.length) groups.push({ key: "yours", label: "Yours", rows: mine.map(row) });
  const people = new Map<string, { name: string; sqlName: string }>();
  for (const t of others) people.set(t.owner.sqlName, t.owner);
  for (const person of [...people.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    groups.push({
      key: `person:${person.sqlName}`,
      label: person.name,
      sqlName: person.sqlName,
      rows: others.filter((t) => t.owner.sqlName === person.sqlName).map(row),
    });
  }
  return groups;
}
