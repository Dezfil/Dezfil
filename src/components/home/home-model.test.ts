import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogueState, TemplateCard, TemplateList } from "@/lib/templates/card";
import type { MapOverview, TableListing } from "../api";
import type { PersonLabel } from "../sharing/people";
import type { WorkflowListing } from "../workflow-model";
import {
  asksRefresh,
  homeView,
  type HomeLead,
  type HomeProject,
  type HomeRead,
  type HomeReader,
  type HomeReads,
  type HomeRecent,
  type HomeShelf,
} from "./home-model";

/**
 * Home's model from fixtures. Every fixture is built as the reads answer
 * it on the wire (the JSON the list operations return, round-tripped), and
 * every expected lead, row, order and count below is written out by hand
 * from the rules, never computed by the model under test.
 */

/* People: the reader is Ada; Bo and Cy own shared work. */
const ADA: PersonLabel = { name: "Ada Lovelace", sqlName: "ada" };
const BO: PersonLabel = { name: "Bo Brandt", sqlName: "bo" };
const CY: PersonLabel = { name: "Cy Chen", sqlName: "cy" };
const READER = { name: ADA.name, sqlName: ADA.sqlName };
const DELETED = { deleted: true } as const;

/** Day `d` of October 2026 at `h` o'clock, as the server writes times. */
const at = (d: number, h = 9) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

/** Through JSON, as the reads deliver it. */
const wire = <T,>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

type Actor = PersonLabel | typeof DELETED | null;

function map(
  id: string,
  f: { owner?: PersonLabel; by?: Actor; changed?: string | null; updated?: string; project?: string | null; layers?: number } = {},
): MapOverview {
  const owner = f.owner ?? ADA;
  const changed = f.changed === undefined ? at(1) : f.changed;
  return wire({
    id, name: `Map ${id}`, projectId: f.project ?? null, owner, home: owner.sqlName,
    layerCount: f.layers ?? 1, layerColors: [], published: false, publishToken: null,
    createdAt: at(1), updatedAt: f.updated ?? changed ?? at(1),
    editRevision: `rev-${id}`, lastChangedAt: changed, lastChangedBy: f.by === undefined ? owner : f.by,
  });
}

function wf(
  id: string,
  f: {
    owner?: PersonLabel; by?: Actor; changed?: string | null; updated?: string; project?: string | null;
    origin?: "workflow" | "builder"; toRunAgain?: number;
  } = {},
): WorkflowListing {
  const owner = f.owner ?? ADA;
  const changed = f.changed === undefined ? at(1) : f.changed;
  const again = f.toRunAgain ?? 0;
  return wire({
    id, name: `Flow ${id}`, origin: f.origin ?? "workflow", projectId: f.project ?? null, owner, home: owner.sqlName,
    createdAt: at(1), updatedAt: f.updated ?? changed ?? at(1),
    editRevision: `rev-${id}`, lastChangedAt: changed, lastChangedBy: f.by === undefined ? owner : f.by,
    summary: { nodes: 2, sources: 1, liveOutputs: 1, status: again > 0 ? "run_again" : "up_to_date", count: again },
    steps: [],
  });
}

function table(id: string, f: { owner?: PersonLabel; imported?: string | null; created?: string; projects?: string[] } = {}): TableListing {
  const owner = f.owner ?? ADA;
  return wire({
    id, name: `table_${id}`, projectIds: f.projects ?? [], owner, qualifiedName: `table_${id}`,
    rowCount: 10, geometryColumn: null, geometryType: null, sizeBytes: 100,
    createdAt: f.created ?? at(1), importedAt: f.imported === undefined ? at(1) : f.imported,
  });
}

const catalogue = (state: CatalogueState["state"], reason: CatalogueState["reason"] = null): CatalogueState => ({
  state, host: null, folder: false, readAt: null, reason, status: reason === "status" ? 503 : null,
});

function card(id: string): TemplateCard {
  return {
    id, kind: "map", version: 1, title: `Template ${id}`, question: `What is ${id}?`, place: "Berlin",
    tags: [], dataDate: "2026", sources: [], steps: null, origin: id.startsWith("s") ? "shipped" : "catalogue",
    installed: 1, listed: null, present: true, size: 1, picture: "kept",
  };
}

function list(ids: string[], state: CatalogueState["state"] = "not_read"): TemplateList {
  return wire({ templates: ids.map(card), catalogue: catalogue(state), downloads: { versions: 0, bytes: 0 } });
}

/** t01 … tNN, the order the list answers in. */
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);

const ready = <T,>(value: T): HomeRead<T> => ({ status: "ready", value });
const PENDING = { status: "pending" } as const;
const failed = (error: string) => ({ status: "failed", error }) as const;

const project = (id: string, role: HomeProject["role"]): HomeProject => ({ id, name: `Project ${id}`, role });

function reads(over: Partial<HomeReads> = {}): HomeReads {
  return {
    maps: ready([]),
    workflows: ready([]),
    tables: ready([]),
    projects: ready([]),
    templates: ready(list(["s1", "s2", "s3"])),
    ...over,
  };
}

const view = (over: Partial<HomeReads> = {}, reader: HomeReader = READER) => homeView(reads(over), reader);

/** The lead as a short word: "map:<id>", "workflow:<id>", "template:<id>",
 * or its state. */
function leadWord(lead: HomeLead): string {
  if (lead.kind === "continue") return `${lead.item.kind}:${lead.item.id}`;
  if (lead.kind === "template") return `template:${lead.card.id}`;
  return lead.kind;
}

const recentIds = (recent: HomeRecent) => (recent.state === "shown" ? recent.items.map((i) => i.id) : recent.state);
const shelfIds = (shelf: HomeShelf) => (shelf.state === "shown" ? shelf.cards.map((c) => c.id) : shelf.state);

const permutations = <T,>(xs: T[]): T[][] =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

describe("the lead: the person's own last change among maps and workflows", () => {
  it("a shared map the person changed after their own map leads, wearing its owner", () => {
    const v = view({
      maps: ready([map("own", { changed: at(1) }), map("shared", { owner: BO, by: ADA, changed: at(2), project: "p1" })]),
    });
    expect(leadWord(v.lead)).toBe("map:shared");
    expect(v.lead.kind === "continue" && v.lead.owner).toEqual(BO);
  });

  it("a shared map someone else changed later still is not the person's: their own older map leads, with no pill", () => {
    const v = view({
      maps: ready([map("own", { changed: at(1) }), map("shared", { owner: BO, by: BO, changed: at(3), project: "p1" })]),
    });
    expect(leadWord(v.lead)).toBe("map:own");
    expect(v.lead.kind === "continue" && v.lead.owner).toBeNull();
  });

  it("a map of the person's with no recorded author never leads through its ownership", () => {
    const v = view({ maps: ready([map("own", { changed: at(1) }), map("unknown", { by: null, changed: at(5) })]) });
    expect(leadWord(v.lead)).toBe("map:own");
  });

  it("a map of the person's whose last author was deleted ({ deleted: true } on the wire) never leads through its ownership", () => {
    const v = view({ maps: ready([map("own", { changed: at(1) }), map("gone", { by: DELETED, changed: at(5) })]) });
    expect(leadWord(v.lead)).toBe("map:own");
  });

  it("a workflow of the person's whose last author was deleted never leads either", () => {
    const v = view({
      maps: ready([map("own", { changed: at(1) })]),
      workflows: ready([wf("gone", { by: DELETED, changed: at(5) })]),
    });
    expect(leadWord(v.lead)).toBe("map:own");
  });

  it("a dataset and a builder-origin recipe newer than everything never lead", () => {
    const v = view({
      maps: ready([map("own", { changed: at(1) })]),
      workflows: ready([wf("builder", { origin: "builder", changed: at(9) })]),
      tables: ready([table("newest", { imported: at(9) })]),
    });
    expect(leadWord(v.lead)).toBe("map:own");
  });

  it("a workflow changed after every map leads", () => {
    const v = view({
      maps: ready([map("older", { changed: at(1) }), map("old", { changed: at(2) })]),
      workflows: ready([wf("newer", { changed: at(4) })]),
    });
    expect(leadWord(v.lead)).toBe("workflow:newer");
  });

  it("a map just created, with no layer yet, leads", () => {
    const v = view({
      maps: ready([map("before", { changed: at(2) }), map("made", { changed: at(6), layers: 0 })]),
      workflows: ready([wf("flow", { changed: at(3) })]),
    });
    expect(leadWord(v.lead)).toBe("map:made");
  });

  it("a workflow example's copy: its map leads over its workflow made at the same moment, whatever their identities", () => {
    const v = view({
      maps: ready([map("zz-copy", { changed: at(7) })]),
      workflows: ready([wf("aa-copy", { changed: at(7) })]),
      tables: ready([table("aa-output", { imported: at(7) })]),
    });
    expect(leadWord(v.lead)).toBe("map:zz-copy");
  });

  it("reads the last-change clock, never the general update time", () => {
    const v = view({
      maps: ready([
        map("changed-last", { changed: at(3), updated: at(3) }),
        map("touched-last", { changed: at(2), updated: at(8) }),
      ]),
    });
    expect(leadWord(v.lead)).toBe("map:changed-last");
  });

  it("with no change of the person's the first template of the list leads; with no template, nothing does", () => {
    const shared = { maps: ready([map("theirs", { owner: BO, by: BO, project: "p1" })]) };
    expect(leadWord(view(shared).lead)).toBe("template:s1");
    expect(leadWord(view({ ...shared, templates: ready(list([])) }).lead)).toBe("none");
  });

  it("an unknown reader has no change of their own", () => {
    const v = view({ maps: ready([map("own")]) }, { name: null, sqlName: null });
    expect(leadWord(v.lead)).toBe("template:s1");
  });
});

describe("equal times", () => {
  it("give the same lead whatever order the lists answer in: the lower identity within a kind", () => {
    const leads = new Set<string>();
    for (const maps of permutations(["m-c", "m-a", "m-b"]))
      for (const flows of permutations(["w-b", "w-a"]))
        leads.add(leadWord(view({
          maps: ready(maps.map((id) => map(id, { changed: at(5) }))),
          workflows: ready(flows.map((id) => wf(id, { changed: at(4) }))),
        }).lead));
    expect([...leads]).toEqual(["map:m-a"]);
  });

  it("among workflows alone, the lower identity", () => {
    const leads = new Set<string>();
    for (const flows of permutations(["w-c", "w-a", "w-b"]))
      leads.add(leadWord(view({ workflows: ready(flows.map((id) => wf(id, { changed: at(5) }))) }).lead));
    expect([...leads]).toEqual(["workflow:w-a"]);
  });

  it("give the same Recent order whatever order the lists answer in: map, workflow, dataset, then the lower identity", () => {
    const orders = new Set<string>();
    for (const maps of permutations(["m-b", "m-a"]))
      for (const flows of permutations(["w-b", "w-a"]))
        for (const tables of permutations(["t-b", "t-a"]))
          orders.add(String(recentIds(view({
            // None of these is Ada's change, so none of them leads.
            maps: ready(maps.map((id) => map(id, { owner: BO, by: BO, updated: at(5), project: "p1" }))),
            workflows: ready(flows.map((id) => wf(id, { owner: BO, by: BO, updated: at(5), project: "p1" }))),
            tables: ready(tables.map((id) => table(id, { owner: BO, imported: at(5), projects: ["p1"] }))),
          }).recent)));
    expect([...orders]).toEqual(["m-a,m-b,w-a,w-b,t-a,t-b"]);
  });
});

describe("the lead waits for both the maps and the workflows reads", () => {
  it("with the workflows read pending, no template stands in the lead's place", () => {
    const v = view({ workflows: PENDING });
    expect(leadWord(v.lead)).toBe("pending");
  });

  it("with the workflows read pending, the person's own map does not lead either", () => {
    const v = view({ maps: ready([map("own", { changed: at(1) })]), workflows: PENDING });
    expect(leadWord(v.lead)).toBe("pending");
  });

  it("with the maps read pending and the workflows answered, nothing leads yet", () => {
    const v = view({ maps: PENDING, workflows: ready([wf("own", { changed: at(1) })]) });
    expect(leadWord(v.lead)).toBe("pending");
  });

  it("a failed read is named with its sentence, and the lead waits on it", () => {
    const v = view({ maps: ready([map("own")]), workflows: failed("The workflows could not be read.") });
    expect(v.lead).toEqual({ kind: "failed", reads: ["workflows"], error: "The workflows could not be read." });
    const both = view({ maps: failed("Maps failed."), workflows: failed("Workflows failed.") });
    expect(both.lead).toEqual({ kind: "failed", reads: ["maps", "workflows"], error: "Maps failed." });
  });

  it("once the retried read answers, the fixture's lead stands", () => {
    const maps = ready([map("own", { changed: at(1) })]);
    expect(leadWord(view({ maps, workflows: failed("x") }).lead)).toBe("failed");
    expect(leadWord(view({ maps, workflows: ready([wf("later", { changed: at(2) })]) }).lead)).toBe("workflow:later");
  });

  it("with no change of the person's, the template lead waits for the template list; Continue does not", () => {
    expect(leadWord(view({ templates: PENDING }).lead)).toBe("pending");
    expect(leadWord(view({ maps: ready([map("own")]), templates: PENDING }).lead)).toBe("map:own");
  });

  it("a failed template list leaves no lead, and Continue stands without it", () => {
    expect(leadWord(view({ templates: failed("x") }).lead)).toBe("none");
    expect(leadWord(view({ maps: ready([map("own")]), templates: failed("x") }).lead)).toBe("map:own");
  });
});

describe("Recent", () => {
  /** Twelve items across the three kinds, each at its own update time:
   * the person's last change is m3, which is not the newest by update. */
  const twelve = {
    maps: ready([
      map("m1", { changed: at(1), updated: at(20) }),
      map("m2", { owner: BO, by: BO, updated: at(19), project: "p1" }),
      map("m3", { changed: at(9), updated: at(18) }),
      map("m4", { changed: at(2), updated: at(8) }),
      map("m5", { changed: at(3), updated: at(4) }),
    ]),
    workflows: ready([
      wf("w1", { changed: at(1), updated: at(17) }),
      wf("w2", { owner: CY, by: CY, updated: at(15), project: "p2" }),
      wf("w3", { changed: at(1), updated: at(7) }),
      wf("w4", { changed: at(1), updated: at(3) }),
    ]),
    tables: ready([
      table("d1", { imported: at(16) }),
      table("d2", { imported: null, created: at(14) }),
      table("d3", { imported: at(5) }),
    ]),
    projects: ready([project("p1", "editor"), project("p2", "viewer")]),
  };

  it("lists eight newest first across the three kinds, by update time and a dataset's import or creation time, the lead left out", () => {
    const v = view(twelve);
    expect(leadWord(v.lead)).toBe("map:m3");
    expect(recentIds(v.recent)).toEqual(["m1", "m2", "w1", "d1", "w2", "d2", "m4", "w3"]);
  });

  it("leaves the lead out by its identity and lets the next item in", () => {
    const v = view({
      maps: ready([
        map("lead", { changed: at(9), updated: at(9) }),
        ...["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id, i) =>
          map(id, { owner: BO, by: BO, updated: at(8 - Math.floor(i / 2), 12 - i), project: "p1" }),
        ),
      ]),
    });
    expect(leadWord(v.lead)).toBe("map:lead");
    expect(recentIds(v.recent)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("leaves a workflow lead out and keeps a map of the same identity", () => {
    const v = view({
      maps: ready([map("same", { owner: BO, by: BO, updated: at(4), project: "p1" })]),
      workflows: ready([wf("same", { changed: at(6), updated: at(6) })]),
    });
    expect(leadWord(v.lead)).toBe("workflow:same");
    expect(recentIds(v.recent)).toEqual(["same"]);
    expect(v.recent.state === "shown" && v.recent.items[0].kind).toBe("map");
  });

  it("puts the owner on someone else's rows and none on the person's own", () => {
    const v = view(twelve);
    const owners = v.recent.state === "shown" ? v.recent.items.map((i) => [i.id, i.owner?.sqlName ?? null]) : [];
    expect(owners).toEqual([
      ["m1", null], ["m2", "bo"], ["w1", null], ["d1", null], ["w2", "cy"], ["d2", null], ["m4", null], ["w3", null],
    ]);
  });

  it("names where each item lives once the projects answered: one, several, none, and one no longer reached", () => {
    const v = view({
      maps: ready([map("in-one", { changed: at(9), project: "p1" }), map("in-none", { changed: at(1), updated: at(8) })]),
      workflows: ready([wf("unreached", { changed: at(1), updated: at(7), project: "gone" })]),
      tables: ready([table("in-two", { imported: at(6), projects: ["p2", "p1"] })]),
      projects: ready([project("p1", "owner"), project("p2", "editor")]),
      templates: ready(list([])),
    });
    const where = v.recent.state === "shown" ? v.recent.items.map((i) => [i.id, i.where]) : [];
    expect(where).toEqual([
      ["in-none", []],
      ["unreached", ["a project you no longer reach"]],
      ["in-two", ["Project p1", "Project p2"]],
    ]);
    expect(leadWord(v.lead)).toBe("map:in-one");
  });

  it("withholds a filed item's where line while the projects are unknown, says an unfiled one's, and keeps every owner", () => {
    for (const projects of [PENDING, failed("The projects could not be read.")] as const) {
      const v = view({
        maps: ready([map("filed", { owner: BO, by: BO, updated: at(9), project: "p1" })]),
        tables: ready([
          table("loose", { imported: at(8) }),
          table("filed-table", { owner: CY, imported: at(7), projects: ["p1"] }),
        ]),
        projects,
      });
      const rows = v.recent.state === "shown" ? v.recent.items.map((i) => [i.id, i.where, i.owner?.sqlName ?? null]) : [];
      expect(rows).toEqual([
        ["filed", null, "bo"],
        ["loose", [], null],
        ["filed-table", null, "cy"],
      ]);
    }
  });

  it("waits while any of the three reads is pending", () => {
    expect(view({ maps: ready([map("own")]), tables: PENDING }).recent).toEqual({ state: "pending" });
    expect(view({ workflows: PENDING }).recent).toEqual({ state: "pending" });
  });

  it("shows the kinds that answered beside the failure of a kind that did not", () => {
    const v = view({
      maps: failed("The maps could not be read."),
      workflows: ready([wf("theirs", { owner: BO, by: BO, updated: at(3), project: "p1" })]),
      tables: ready([table("mine", { imported: at(2) })]),
    });
    expect(v.recent).toMatchObject({ state: "shown", failed: [{ read: "maps", error: "The maps could not be read." }] });
    expect(recentIds(v.recent)).toEqual(["theirs", "mine"]);
  });

  it("stands with a failure even when the kinds that answered list nothing", () => {
    const v = view({ tables: failed("The datasets could not be read.") });
    expect(v.recent).toEqual({ state: "shown", items: [], failed: [{ read: "tables", error: "The datasets could not be read." }] });
  });

  it("is absent with nothing to list, and when the only item is the lead", () => {
    expect(view().recent).toEqual({ state: "absent" });
    const one = view({ maps: ready([map("only")]) });
    expect(leadWord(one.lead)).toBe("map:only");
    expect(one.recent).toEqual({ state: "absent" });
  });
});

describe("the templates below", () => {
  it("a person reaching nothing sees eight after the template lead, in the list's order, with the fresh words", () => {
    const v = view({ templates: ready(list(numbered(10))) });
    expect(leadWord(v.lead)).toBe("template:t01");
    expect(shelfIds(v.shelf)).toEqual(["t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09"]);
    expect(v.shelf).toMatchObject({ heading: "What Dezfil can do", countLine: "10 templates on open data", link: "All templates", count: 10 });
  });

  it("a person whose one item is their own map sees Continue, no Recent and the first four", () => {
    const v = view({ maps: ready([map("mine")]), templates: ready(list(numbered(10))) });
    expect(leadWord(v.lead)).toBe("map:mine");
    expect(v.recent).toEqual({ state: "absent" });
    expect(shelfIds(v.shelf)).toEqual(["t01", "t02", "t03", "t04"]);
    expect(v.shelf).toMatchObject({ heading: "From the templates", countLine: null, link: "All 10 templates" });
  });

  it("a newcomer reaching shared work they never changed: the template lead, the shared work in Recent wearing its owners, and four", () => {
    const v = view({
      maps: ready([map("their-map", { owner: BO, by: BO, updated: at(4), project: "p1" })]),
      workflows: ready([wf("their-flow", { owner: CY, by: CY, updated: at(3), project: "p1" })]),
      projects: ready([project("p1", "viewer")]),
      templates: ready(list(numbered(10))),
    });
    expect(v.welcome).toBe("Welcome, Ada");
    expect(leadWord(v.lead)).toBe("template:t01");
    const rows = v.recent.state === "shown" ? v.recent.items.map((i) => [i.id, i.owner?.sqlName]) : [];
    expect(rows).toEqual([["their-map", "bo"], ["their-flow", "cy"]]);
    expect(shelfIds(v.shelf)).toEqual(["t02", "t03", "t04", "t05"]);
    expect(v.shelf).toMatchObject({ heading: "From the templates", link: "All 10 templates" });
  });

  it("a returning member whose latest own change is to a shared workflow sees it as Continue wearing its owner", () => {
    const v = view({
      maps: ready([map("mine", { changed: at(2) })]),
      workflows: ready([wf("team-flow", { owner: BO, by: ADA, changed: at(5), project: "p1" })]),
      projects: ready([project("p1", "editor")]),
    });
    expect(v.welcome).toBe("Welcome back, Ada");
    expect(leadWord(v.lead)).toBe("workflow:team-flow");
    expect(v.lead.kind === "continue" && v.lead.owner).toEqual(BO);
    expect(recentIds(v.recent)).toEqual(["mine"]);
  });

  it("over eleven, four, two, one and zero templates, with and without work: the order kept, the lead out, fewer shown, none left no section", () => {
    const work = { maps: ready([map("mine")]) };
    const cases: [number, boolean, string[] | string][] = [
      [11, false, ["t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09"]],
      [11, true, ["t01", "t02", "t03", "t04"]],
      [4, false, ["t02", "t03", "t04"]],
      [4, true, ["t01", "t02", "t03", "t04"]],
      [2, false, ["t02"]],
      [2, true, ["t01", "t02"]],
      [1, false, "absent"],
      [1, true, ["t01"]],
      [0, false, "absent"],
      [0, true, "absent"],
    ];
    for (const [n, withWork, expected] of cases) {
      const v = view({ ...(withWork ? work : {}), templates: ready(list(numbered(n))) });
      expect([n, withWork, shelfIds(v.shelf)]).toEqual([n, withWork, expected]);
    }
  });

  it("with no template, Continue and Recent still stand", () => {
    const v = view({
      maps: ready([map("mine", { changed: at(3) }), map("theirs", { owner: BO, by: BO, updated: at(2), project: "p1" })]),
      templates: ready(list([])),
    });
    expect(leadWord(v.lead)).toBe("map:mine");
    expect(recentIds(v.recent)).toEqual(["theirs"]);
    expect(v.shelf).toEqual({ state: "absent" });
  });

  it("says one template in the singular", () => {
    const v = view({ maps: ready([map("mine")]), templates: ready(list(["s1"])) });
    expect(v.shelf).toMatchObject({ heading: "From the templates", link: "All 1 template" });
  });

  it("shows eight only once all three of the person's lists have answered empty", () => {
    const v = view({ tables: PENDING, templates: ready(list(numbered(10))) });
    expect(leadWord(v.lead)).toBe("template:t01");
    expect(shelfIds(v.shelf)).toEqual(["t02", "t03", "t04", "t05"]);
    expect(v.shelf).toMatchObject({ heading: "From the templates" });
  });

  it("waits while the lead waits, since which template the lead takes is not known yet", () => {
    const v = view({ workflows: PENDING, templates: ready(list(numbered(10))) });
    expect(leadWord(v.lead)).toBe("pending");
    expect(v.shelf).toEqual({ state: "pending" });
    expect(view({ maps: PENDING, templates: ready(list(numbered(10))) }).shelf).toEqual({ state: "pending" });
  });

  it("draws four from the top once the lead has failed, with nothing left out", () => {
    const v = view({ workflows: failed("The workflows could not be read."), templates: ready(list(numbered(10))) });
    expect(leadWord(v.lead)).toBe("failed");
    expect(shelfIds(v.shelf)).toEqual(["t01", "t02", "t03", "t04"]);
    expect(v.shelf).toMatchObject({ heading: "From the templates", link: "All 10 templates" });
  });

  it("names the template list's failure even while the lead waits", () => {
    expect(view({ workflows: PENDING, templates: failed("The templates could not be read.") }).shelf).toEqual({
      state: "failed", error: "The templates could not be read.",
    });
  });

  it("waits for the template list, and names its failure", () => {
    expect(view({ templates: PENDING }).shelf).toEqual({ state: "pending" });
    expect(view({ templates: failed("The templates could not be read.") }).shelf).toEqual({
      state: "failed", error: "The templates could not be read.",
    });
  });

  it("follows the refresh's answer, unchanged, smaller or larger, with the shipped lead unmoved", () => {
    const first = view({ templates: ready(list(["s1", "s2", "s3", "c1", "c2"])) });
    expect(leadWord(first.lead)).toBe("template:s1");
    expect(first.shelf).toMatchObject({ countLine: "5 templates on open data" });
    const answers: [string[], string[], string][] = [
      [["s1", "s2", "s3", "c1", "c2"], ["s2", "s3", "c1", "c2"], "5 templates on open data"],
      [["s1", "s2", "s3"], ["s2", "s3"], "3 templates on open data"],
      [["s1", "s2", "s3", "c1", "c2", "c3", "c4", "c5", "c6", "c7"], ["s2", "s3", "c1", "c2", "c3", "c4", "c5", "c6"], "10 templates on open data"],
    ];
    for (const [ids, shelf, count] of answers) {
      const v = view({ templates: ready(list(ids, "listed")) });
      expect([leadWord(v.lead), shelfIds(v.shelf), v.shelf.state === "shown" && v.shelf.countLine]).toEqual(["template:s1", shelf, count]);
    }
  });

  it("takes the template lead from the first answer that lists some when none was there", () => {
    expect(leadWord(view({ templates: ready(list([])) }).lead)).toBe("none");
    const after = view({ templates: ready(list(["c1", "c2"], "listed")) });
    expect(leadWord(after.lead)).toBe("template:c1");
    expect(shelfIds(after.shelf)).toEqual(["c2"]);
  });
});

describe("the rows to run again", () => {
  /** Four workflows to run again: Ada's own, one in a project she edits,
   * one Cy made in a project Ada owns, one in a project she only views. */
  const four = ready([
    wf("own", { toRunAgain: 2 }),
    wf("in-edited", { owner: BO, by: BO, project: "p-edit", toRunAgain: 1 }),
    wf("in-owned", { owner: CY, by: CY, project: "p-own", toRunAgain: 3 }),
    wf("in-viewed", { owner: BO, by: BO, project: "p-view", toRunAgain: 1 }),
    wf("current", { toRunAgain: 0 }),
  ]);
  const roles = ready([project("p-edit", "editor"), project("p-own", "owner"), project("p-view", "viewer")]);
  const rowWords = (v: ReturnType<typeof view>) =>
    v.runRows.map((r) => [r.id, r.owner?.sqlName ?? null, r.withheld?.status ?? "run"]);

  it("with the projects answered: the person's own, an edited project's and an owned project's, two wearing owners; a viewed project's is gone", () => {
    expect(rowWords(view({ workflows: four, projects: roles }))).toEqual([
      ["own", null, "run"],
      ["in-edited", "bo", "run"],
      ["in-owned", "cy", "run"],
    ]);
  });

  it("with the projects pending: the person's own Run offered, every other row standing with Run withheld", () => {
    expect(rowWords(view({ workflows: four, projects: PENDING }))).toEqual([
      ["own", null, "run"],
      ["in-edited", "bo", "pending"],
      ["in-owned", "cy", "pending"],
      ["in-viewed", "bo", "pending"],
    ]);
  });

  it("with the projects failed: the same rows, Run withheld with the read's failure", () => {
    const v = view({ workflows: four, projects: failed("The projects could not be read.") });
    expect(rowWords(v)).toEqual([
      ["own", null, "run"],
      ["in-edited", "bo", "failed"],
      ["in-owned", "cy", "failed"],
      ["in-viewed", "bo", "failed"],
    ]);
    expect(v.runRows[1].withheld).toEqual({ status: "failed", error: "The projects could not be read." });
  });

  it("after the retry, an editor's Run appears and a viewer's row is gone", () => {
    const shared = ready([wf("own", { toRunAgain: 1 }), wf("shared", { owner: BO, by: BO, project: "p1", toRunAgain: 1 })]);
    const before = view({ workflows: shared, projects: failed("x") });
    expect(rowWords(before)).toEqual([["own", null, "run"], ["shared", "bo", "failed"]]);
    expect(rowWords(view({ workflows: shared, projects: ready([project("p1", "editor")]) }))).toEqual([
      ["own", null, "run"], ["shared", "bo", "run"],
    ]);
    expect(rowWords(view({ workflows: shared, projects: ready([project("p1", "viewer")]) }))).toEqual([["own", null, "run"]]);
  });

  it("carries the attention row's count and cause from the listing", () => {
    const v = view({ workflows: four, projects: roles });
    expect(v.runRows.map((r) => [r.name, r.count, r.cause])).toEqual([
      ["Flow own", 2, null], ["Flow in-edited", 1, null], ["Flow in-owned", 3, null],
    ]);
  });

  it("are none until the workflows read answers", () => {
    expect(view({ workflows: PENDING }).runRows).toEqual([]);
    expect(view({ workflows: failed("x") }).runRows).toEqual([]);
  });
});

describe("the welcome", () => {
  it("is 'Welcome back' with Continue and 'Welcome' otherwise, by the first word of the display name", () => {
    expect(view({ maps: ready([map("mine")]) }).welcome).toBe("Welcome back, Ada");
    expect(view().welcome).toBe("Welcome, Ada");
    expect(view({ templates: ready(list([])) }).welcome).toBe("Welcome, Ada");
    expect(view({ workflows: PENDING }).welcome).toBe("Welcome, Ada");
  });

  it("names nobody when the name is unknown or blank", () => {
    expect(view({}, { name: null, sqlName: "ada" }).welcome).toBe("Welcome");
    expect(view({ maps: ready([map("mine")]) }, { name: "  ", sqlName: "ada" }).welcome).toBe("Welcome back");
  });
});

describe("the refresh ask", () => {
  it("is made once the list answered, whatever the catalogue said, unless it is off or its address cannot be read", () => {
    const asks = (state: CatalogueState["state"], reason: CatalogueState["reason"] = null) =>
      asksRefresh(ready({ ...list(["s1"]), catalogue: catalogue(state, reason) }));
    expect([
      asks("not_read"), asks("listed"), asks("empty"), asks("unreachable"), asks("slow"), asks("refused", "status"),
      asks("refused", "egress_blocked"),
    ]).toEqual([true, true, true, true, true, true, true]);
    expect([asks("off"), asks("refused", "service_address_unreadable")]).toEqual([false, false]);
  });

  it("is not made before the list answered, nor after it failed", () => {
    expect(asksRefresh(PENDING)).toBe(false);
    expect(asksRefresh(failed("x"))).toBe(false);
  });
});

describe("the reads alone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("give the same page on any day: nothing but the answers decides it", () => {
    const input = {
      maps: ready([map("m", { changed: at(2) }), map("n", { owner: BO, by: BO, updated: at(3), project: "p1" })]),
      workflows: ready([wf("w", { changed: at(1), toRunAgain: 1 })]),
      tables: ready([table("d", { imported: at(4) })]),
      projects: ready([project("p1", "viewer")]),
      templates: ready(list(numbered(6))),
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const today = view(input);
    vi.setSystemTime(new Date("2027-03-01T12:00:00Z"));
    expect(view(input)).toEqual(today);
    expect(leadWord(today.lead)).toBe("map:m");
    expect(recentIds(today.recent)).toEqual(["d", "n", "w"]);
  });
});
