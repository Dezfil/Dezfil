import { isDeletedActor, type AccountActor } from "@/lib/account-actor";
import type { TemplateCard, TemplateList } from "@/lib/templates/card";
import type { MapOverview, TableListing } from "../api";
import { attentionRows, type AttentionRow } from "../projects/home-model";
import { recentItems, type RecentExclusion, type RecentItem } from "../projects/recent-model";
import { firstName, ownedByOther, type PersonLabel, type ProjectRole } from "../sharing/people";
import { refreshes } from "../templates/template-model";
import type { WorkflowListing } from "../workflow-model";

/**
 * Home's model: what the page shows, worked out from the answers of the
 * reads it makes as the signed-in person and from nothing else, so an
 * agent calling the same reads computes the same page. Nothing is stored
 * for Home and nothing here reads a clock: the lead, Recent, the rows to
 * run again, the templates below and the welcome are the same for the
 * same answers on any day. Pure: no React, no fetch.
 */

/** A read as Home holds it, shaped as the shipped async state, so a page
 * passes its reads as they stand. */
export type HomeRead<T> =
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "ready"; value: T };

/** A project as the projects list answers it: the name a where line says,
 * and how the reader stands to it. */
export interface HomeProject {
  id: string;
  name: string;
  role?: ProjectRole;
}

export interface HomeReads {
  maps: HomeRead<readonly MapOverview[]>;
  /** The workflows of workflow origin; a builder-origin recipe among them
   * is ignored. */
  workflows: HomeRead<readonly WorkflowListing[]>;
  tables: HomeRead<readonly TableListing[]>;
  projects: HomeRead<readonly HomeProject[]>;
  /** The template list as it stands: the list read's answer, or the
   * refresh's once that answered. */
  templates: HomeRead<TemplateList>;
}

/** The signed-in person as the shell names them; null when unknown. */
export interface HomeReader {
  name: string | null;
  sqlName: string | null;
}

/** The three lists of things a person reaches, by the read's name. */
export type ListRead = "maps" | "workflows" | "tables";

/** Recent's rows at most. */
export const HOME_RECENT_LIMIT = 8;
/** Templates below for a person who reaches nothing yet, and otherwise. */
export const SHELF_WHEN_NOTHING = 8;
export const SHELF_OTHERWISE = 4;

/* The lead ---- */

/** The person's own last change: a map or a workflow, at its last-change
 * time. */
export type ContinueItem =
  | { kind: "map"; id: string; changedAt: string; map: MapOverview }
  | { kind: "workflow"; id: string; changedAt: string; workflow: WorkflowListing };

export type HomeLead =
  /** The maps or the workflows have not answered, or nothing of the
   * person's leads and the template list has not answered. */
  | { kind: "pending" }
  /** The maps or the workflows read failed: the failed reads, and the
   * first one's sentence. */
  | { kind: "failed"; reads: ("maps" | "workflows")[]; error: string }
  /** `owner` on someone else's item, null on the person's own. */
  | { kind: "continue"; item: ContinueItem; owner: PersonLabel | null }
  | { kind: "template"; card: TemplateCard }
  /** No change of the person's and no template. */
  | { kind: "none" };

/** Whether a change was the reader's: a named actor with the reader's SQL
 * name. A change with no author, or by a deleted account (which carries no
 * name on purpose), is nobody's: ownership never stands in for it, since a
 * migrated record keeps no author and guessing one invents a fact. */
function changedByReader(actor: AccountActor | null | undefined, me: string | null): boolean {
  return me !== null && !!actor && !isDeletedActor(actor) && actor.sqlName === me;
}

const LEAD_KIND_ORDER: Record<ContinueItem["kind"], number> = { map: 0, workflow: 1 };

/** Whether `a` leads over `b`: the later last change; at the same moment a
 * map over a workflow (a workflow example's copy makes both, and the map is
 * what the person came to work on), then the lower identity, so the lead
 * never depends on the order the lists answered in. */
function leadsOver(a: ContinueItem, b: ContinueItem): boolean {
  const ta = Date.parse(a.changedAt);
  const tb = Date.parse(b.changedAt);
  if (ta !== tb) return ta > tb;
  if (a.kind !== b.kind) return LEAD_KIND_ORDER[a.kind] < LEAD_KIND_ORDER[b.kind];
  return a.id < b.id;
}

/** Among the maps and workflow-origin workflows the person reaches, the
 * one whose last recorded change was theirs, the latest such change.
 * Datasets never lead. The last-change time decides, never the general
 * update time, which also moves for bookkeeping nobody did. */
export function lastOwnChange(
  maps: readonly MapOverview[],
  workflows: readonly WorkflowListing[],
  me: string | null,
): ContinueItem | null {
  const candidates: ContinueItem[] = [];
  for (const map of maps) {
    if (!map.lastChangedAt || Number.isNaN(Date.parse(map.lastChangedAt))) continue;
    if (changedByReader(map.lastChangedBy, me)) {
      candidates.push({ kind: "map", id: map.id, changedAt: map.lastChangedAt, map });
    }
  }
  for (const workflow of workflows) {
    if (workflow.origin !== "workflow") continue;
    if (!workflow.lastChangedAt || Number.isNaN(Date.parse(workflow.lastChangedAt))) continue;
    if (changedByReader(workflow.lastChangedBy, me)) {
      candidates.push({ kind: "workflow", id: workflow.id, changedAt: workflow.lastChangedAt, workflow });
    }
  }
  let best: ContinueItem | null = null;
  for (const candidate of candidates) if (!best || leadsOver(candidate, best)) best = candidate;
  return best;
}

/** The lead: chosen only once both the maps and the workflows have
 * answered, so loading never shows as a template or a wrong Continue.
 * The person's own last change leads; else the first template of the list
 * (its order is curated, the shipped ones first); else nothing. */
export function homeLead(
  reads: Pick<HomeReads, "maps" | "workflows" | "templates">,
  me: string | null,
): HomeLead {
  const { maps, workflows, templates } = reads;
  const failures: { read: "maps" | "workflows"; error: string }[] = [];
  if (maps.status === "failed") failures.push({ read: "maps", error: maps.error });
  if (workflows.status === "failed") failures.push({ read: "workflows", error: workflows.error });
  if (failures.length > 0) {
    return { kind: "failed", reads: failures.map((f) => f.read), error: failures[0].error };
  }
  if (maps.status !== "ready" || workflows.status !== "ready") return { kind: "pending" };
  const own = lastOwnChange(maps.value, workflows.value, me);
  if (own) {
    const owner = own.kind === "map" ? own.map.owner : own.workflow.owner;
    return { kind: "continue", item: own, owner: ownedByOther(owner, me) ? owner : null };
  }
  if (templates.status === "pending") return { kind: "pending" };
  if (templates.status === "ready" && templates.value.templates.length > 0) {
    return { kind: "template", card: templates.value.templates[0] };
  }
  return { kind: "none" };
}

/* Recent ---- */

/** A Recent row: the project home's recent item, its where line null while
 * the project names are unknown for an item filed in a project (an
 * unfiled item's "not in a project" is its own record's fact). */
type WhereWithheld<T> = T extends unknown ? Omit<T, "where"> & { where: string[] | null } : never;
export type HomeRecentItem = WhereWithheld<RecentItem>;

export type HomeRecent =
  /** One of the three lists has not answered. */
  | { state: "pending" }
  /** Nothing to list and nothing failed: no section. */
  | { state: "absent" }
  /** The kinds that answered, newest first, and each kind that failed. */
  | { state: "shown"; items: HomeRecentItem[]; failed: { read: ListRead; error: string }[] };

const answered = <T,>(read: HomeRead<readonly T[]>): T[] => (read.status === "ready" ? [...read.value] : []);

function filed(item: RecentItem): boolean {
  if (item.kind === "dataset") return item.table.projectIds.length > 0;
  return (item.kind === "map" ? item.map.projectId : item.workflow.projectId) !== null;
}

function leadExclusion(lead: HomeLead): RecentExclusion {
  const none = new Set<string>();
  if (lead.kind !== "continue") return { maps: none, workflows: none, tables: none };
  const only = new Set([lead.item.id]);
  return lead.item.kind === "map"
    ? { maps: only, workflows: none, tables: none }
    : { maps: none, workflows: only, tables: none };
}

/** Everything the person reaches but the lead, newest first by the general
 * update time (a dataset by its import or creation time), equal times in
 * one order whatever order the lists answered in, eight at most. */
export function homeRecent(reads: HomeReads, me: string | null, lead: HomeLead): HomeRecent {
  const lists: [ListRead, HomeRead<readonly unknown[]>][] = [
    ["maps", reads.maps],
    ["workflows", reads.workflows],
    ["tables", reads.tables],
  ];
  if (lists.some(([, read]) => read.status === "pending")) return { state: "pending" };
  const failed = lists.flatMap(([read, state]) => (state.status === "failed" ? [{ read, error: state.error }] : []));
  const projects = reads.projects;
  const known = projects.status === "ready";
  const names = new Map<string, string>(projects.status === "ready" ? projects.value.map((p) => [p.id, p.name]) : []);
  const items = recentItems({
    maps: answered(reads.maps),
    workflows: answered(reads.workflows),
    tables: answered(reads.tables),
    exclude: leadExclusion(lead),
    names,
    me,
    limit: HOME_RECENT_LIMIT,
    ties: "total",
  }).map((item) => (known || !filed(item) ? item : { ...item, where: null }) as HomeRecentItem);
  if (items.length === 0 && failed.length === 0) return { state: "absent" };
  return { state: "shown", items, failed };
}

/* The rows to run again ---- */

/** A workflow to run again the person may run: the project home's
 * attention row, the owner on someone else's, and Run withheld while the
 * projects read that says who may run it has not answered. */
export interface HomeRunRow extends AttentionRow {
  owner: PersonLabel | null;
  withheld: { status: "pending" } | { status: "failed"; error: string } | null;
}

/** One row per workflow the server classifies as to run again that the
 * person may run: their own, or one filed in a project they own or edit.
 * Until the projects answer, their own rows offer Run and every other row
 * stands with Run withheld; a viewer's row leaves once they answer, since
 * the canvas would refuse that Run. */
export function homeRunRows(reads: Pick<HomeReads, "workflows" | "projects">, me: string | null): HomeRunRow[] {
  if (reads.workflows.status !== "ready") return [];
  const workflows = reads.workflows.value.filter((w) => w.origin === "workflow");
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const projects = reads.projects;
  const roles = projects.status === "ready" ? new Map(projects.value.map((p) => [p.id, p.role])) : null;
  const withheld =
    projects.status === "ready" ? null : projects.status === "failed" ? { status: "failed" as const, error: projects.error } : { status: "pending" as const };
  return attentionRows(workflows).flatMap((row) => {
    const workflow = byId.get(row.id);
    if (!workflow) return [];
    const owner = ownedByOther(workflow.owner, me) ? workflow.owner : null;
    const own = me !== null && workflow.owner?.sqlName === me;
    if (own) return [{ ...row, owner, withheld: null }];
    if (roles === null) return [{ ...row, owner, withheld }];
    const role = workflow.projectId === null ? undefined : roles.get(workflow.projectId);
    return role === "owner" || role === "editor" ? [{ ...row, owner, withheld: null }] : [];
  });
}

/* The templates below ---- */

export type HomeShelf =
  | { state: "pending" }
  | { state: "failed"; error: string }
  /** No template beyond the lead: no section. */
  | { state: "absent" }
  | {
      state: "shown";
      cards: TemplateCard[];
      /** The person reaches nothing yet: the fresh words and eight. */
      reachesNothing: boolean;
      heading: string;
      /** The faint line under the fresh heading; null otherwise. */
      countLine: string | null;
      link: string;
      /** The list's length, the lead included. */
      count: number;
    };

const templatesWord = (n: number) => `${n} template${n === 1 ? "" : "s"}`;

/** Whether the three lists of things the person reaches have all answered
 * empty (builder-origin recipes are not workflows a person sees). */
export function reachesNothing(reads: Pick<HomeReads, "maps" | "workflows" | "tables">): boolean {
  return (
    reads.maps.status === "ready" &&
    reads.maps.value.length === 0 &&
    reads.workflows.status === "ready" &&
    reads.workflows.value.every((w) => w.origin !== "workflow") &&
    reads.tables.status === "ready" &&
    reads.tables.value.length === 0
  );
}

/** Templates from the list in its order, the template lead left out:
 * eight for a person who reaches nothing yet, four otherwise, the same for
 * everyone. While the lead is undecided the shelf waits too, since which
 * template the lead takes, and so which are left, is not known yet; a lead
 * that failed leaves nothing out. */
export function homeShelf(reads: HomeReads, lead: HomeLead): HomeShelf {
  const { templates } = reads;
  if (templates.status === "pending") return { state: "pending" };
  if (templates.status === "failed") return { state: "failed", error: templates.error };
  if (lead.kind === "pending") return { state: "pending" };
  const all = templates.value.templates;
  const rest = lead.kind === "template" ? all.filter((card) => card.id !== lead.card.id) : all;
  const fresh = reachesNothing(reads);
  const cards = rest.slice(0, fresh ? SHELF_WHEN_NOTHING : SHELF_OTHERWISE);
  if (cards.length === 0) return { state: "absent" };
  const count = all.length;
  return fresh
    ? { state: "shown", cards, reachesNothing: true, heading: "What Dezfil can do", countLine: `${templatesWord(count)} on open data`, link: "All templates", count }
    : { state: "shown", cards, reachesNothing: false, heading: "From the templates", countLine: null, link: `All ${templatesWord(count)}`, count };
}

/* The welcome and the refresh ---- */

/** "Welcome back, <first name>" over the person's own last change,
 * "Welcome, <first name>" otherwise; no name when it is unknown. */
export function homeWelcome(name: string | null, lead: HomeLead): string {
  const greeting = lead.kind === "continue" ? "Welcome back" : "Welcome";
  const first = name ? firstName(name).trim() : "";
  return first ? `${greeting}, ${first}` : greeting;
}

/** Whether Home asks the server to read the catalogue after the template
 * list read answered: never before it answered or when it failed, never
 * while the catalogue is off or its saved address cannot be read (the
 * refresh refuses both). Asked of the list read's answer, once per answer;
 * the refresh's own answer asks nothing more. */
export function asksRefresh(listRead: HomeRead<TemplateList>): boolean {
  return listRead.status === "ready" && refreshes(listRead.value.catalogue);
}

/* The page ---- */

export interface HomeView {
  welcome: string;
  lead: HomeLead;
  runRows: HomeRunRow[];
  recent: HomeRecent;
  shelf: HomeShelf;
}

export function homeView(reads: HomeReads, reader: HomeReader): HomeView {
  const me = reader.sqlName;
  const lead = homeLead(reads, me);
  return {
    welcome: homeWelcome(reader.name, lead),
    lead,
    runRows: homeRunRows(reads, me),
    recent: homeRecent(reads, me, lead),
    shelf: homeShelf(reads, lead),
  };
}
