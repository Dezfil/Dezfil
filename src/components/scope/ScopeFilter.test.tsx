import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { scopeRows } from "./model";
import { ScopeMenuRows } from "./ScopeFilter";

/**
 * The project filter's shared group: one's own projects first, then the
 * projects shared with one under a rule headed "Shared with you", each
 * with its owner's first name; Not in a project stays last. The projects
 * directory says each project's owner and the reader's role.
 */

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const projects = [
  { id: "berlin", name: "Berlin housing study", role: "editor" as const, owner: ada },
  { id: "port", name: "Port traffic", role: "owner" as const, owner: bo },
  { id: "quay", name: "Quay survey", role: "owner" as const, owner: bo },
];
const items = [{ p: "berlin" }, { p: "berlin" }, { p: "port" }, { p: null }];
const rows = scopeRows(items, projects, (m: { p: string | null }) => (m.p ? [m.p] : []));

describe("the project filter's shared group", () => {
  it("lists one's own projects, then the shared ones with their owners, then unfiled", () => {
    expect(rows.map((r) => [r.id, r.count, r.shared ? r.owner : null])).toEqual([
      ["all", 4, null],
      ["port", 1, null],
      ["quay", 0, null],
      ["berlin", 2, "Ada"],
      ["none", 1, null],
    ]);
  });

  it("draws the rule and the group's heading once, before the first shared project", () => {
    const html = renderToStaticMarkup(
      <ScopeMenuRows rows={rows} scope={{ kind: "all" }} onPick={() => {}} />,
    );
    expect(html.match(/Shared with you/g)).toHaveLength(1);
    expect(html.match(/role="separator"/g)).toHaveLength(1);
    const order = ["Port traffic", "Quay survey", "Shared with you", "Berlin housing study", "Ada", "Not in a project"]
      .map((text) => html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("draws no group when nothing is shared with one", () => {
    const own = scopeRows(items, projects.filter((p) => p.role === "owner"), (m: { p: string | null }) => (m.p ? [m.p] : []));
    const html = renderToStaticMarkup(<ScopeMenuRows rows={own} scope={{ kind: "all" }} onPick={() => {}} />);
    expect(html).not.toContain("Shared with you");
    expect(html).not.toContain('role="separator"');
  });
});
