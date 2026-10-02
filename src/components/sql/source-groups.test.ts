import { describe, expect, it } from "vitest";
import type { TableListing } from "../api";
import { sourceGroups } from "./source-groups";
import { quotedReference } from "./sql-draft";

/**
 * The console's source list, as Bo, who owns `roads` and `berths` and
 * reaches Ada's `roads` and `rents` through Berlin housing study: by person,
 * "Yours" then Ada's under her name and SQL name, each of hers read as it is
 * typed; by project, one group per project then "Not in a project", each
 * row with its owner. While every listed dataset is Bo's own, by person
 * keeps the list's shipped groups.
 */

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const table = (name: string, owner: typeof ada, projectIds: string[] = [], source = "upload"): TableListing =>
  ({ id: `${owner.sqlName}-${name}`, name, qualifiedName: owner === bo ? name : `${owner.sqlName}.${name}`, owner, projectIds, source }) as unknown as TableListing;
const projects = [{ id: "berlin", name: "Berlin housing study" }, { id: "port", name: "Port traffic" }];
const tables = [
  table("roads", bo, ["port"]), table("berths", bo), table("roads", ada, ["berlin"]), table("rents", ada, ["berlin", "port"]),
];
const shape = (groups: ReturnType<typeof sourceGroups>) =>
  groups.map((g) => ({ label: g.label, sqlName: g.sqlName, rows: g.rows.map((r) => (r.qualifier ? `${r.qualifier}.` : "") + r.table.name) }));

describe("the source list by person", () => {
  it("lists one's own as Yours, then each other person's under their name and SQL name, as typed", () => {
    expect(shape(sourceGroups(tables, { grouping: "person", me: "bo", projects, recipes: [] }))).toEqual([
      { label: "Yours", sqlName: undefined, rows: ["roads", "berths"] },
      { label: "Ada Okafor", sqlName: "ada", rows: ["ada.roads", "ada.rents"] },
    ]);
  });

  it("names on hover the projects someone else's dataset reaches one through", () => {
    const ada = sourceGroups(tables, { grouping: "person", me: "bo", projects, recipes: [] })[1];
    expect(ada.rows.map((r) => r.via)).toEqual(["In Berlin housing study", "In Berlin housing study, Port traffic"]);
  });

  it("keeps the shipped groups while every dataset is one's own", () => {
    const mine = [table("roads", bo), table("lanes", bo, [], "operation")];
    expect(sourceGroups(mine, { grouping: "person", me: "bo", projects, recipes: [] }).map((g) => g.key)).toEqual(["outputs", "workspace"]);
  });
});

describe("the source list by project", () => {
  it("groups by project, then Not in a project, a dataset in two projects in both, each row with its owner", () => {
    const groups = sourceGroups(tables, { grouping: "project", me: "bo", projects, recipes: [] });
    expect(shape(groups)).toEqual([
      { label: "Berlin housing study", sqlName: undefined, rows: ["ada.roads", "ada.rents"] },
      { label: "Port traffic", sqlName: undefined, rows: ["roads", "ada.rents"] },
      { label: "Not in a project", sqlName: undefined, rows: ["berths"] },
    ]);
    expect(groups[0].rows[0].owner).toEqual(ada);
  });
});

describe("the insert action", () => {
  it("quotes every part of the typed name", () => {
    expect(quotedReference("roads")).toBe('"roads"');
    expect(quotedReference("ada.roads")).toBe('"ada"."roads"');
  });
});
