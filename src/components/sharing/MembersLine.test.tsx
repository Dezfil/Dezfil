import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { cssRules } from "../testing/css-rules";
import type { ProjectPersonWire } from "./people";
import { MembersLine } from "./MembersLine";

/**
 * The members line under a project's name on its owner's home: the faces
 * of up to three of its people beside the sentence, each their picture by
 * its version or their first and last initials, a deactivated person's
 * dimmed.
 */

const shared = vi.hoisted(() => ({ people: [] as ProjectPersonWire[] }));
vi.mock("./use-project-people", () => ({ useProjectPeople: () => new Map([["berlin", shared.people]]) }));

const person = (sqlName: string, name: string, role: ProjectPersonWire["role"], extra: Partial<ProjectPersonWire> = {}): ProjectPersonWire =>
  ({ sqlName, name, role, deactivated: false, ...extra });

describe("the members line's faces", () => {
  it("draws each member's picture by its version, the initials of one without, and never the owner", () => {
    shared.people = [person("ada", "Ada Okafor", "owner", { pictureVersion: "a1" }), person("bo", "Bo Lindqvist", "editor", { pictureVersion: "b1" }),
      person("dee", "Dee Anna Ruiz", "viewer")];
    const html = renderToStaticMarkup(<MembersLine projectId="berlin" onOpen={() => {}} />);
    expect(html).toContain('src="/api/accounts/bo/picture?v=b1"');
    expect(html).not.toContain("/api/accounts/ada/picture");
    expect(html).not.toContain("/api/accounts/dee/picture");
    expect(html).toMatch(/data-face="letters">DR</);
    expect(html).toContain("Shared with Bo and Dee");
  });

  it("dims a deactivated member's picture as their initials are dimmed", () => {
    shared.people = [person("ada", "Ada Okafor", "owner"), person("cy", "Cy Marsh", "viewer", { deactivated: true, pictureVersion: "c1" })];
    const html = renderToStaticMarkup(<MembersLine projectId="berlin" onOpen={() => {}} />);
    expect(html).toMatch(/<span data-off="true" class="[^"]*face[^"]*"[^>]*data-face="letters">CM<img[^>]*src="\/api\/accounts\/cy\/picture\?v=c1"/);
    const dim = cssRules("src/components/sharing/MembersLine.module.css").filter((rule) => rule.selector === '.face[data-off][data-face="picture"]');
    expect(dim.map((rule) => /opacity:\s*([^;]+);/.exec(rule.body)?.[1])).toEqual(["0.5"]);
  });
});
