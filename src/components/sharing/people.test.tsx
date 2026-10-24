import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  firstName,
  initials,
  ownedByOther,
  peopleMark,
  sharedWithLine,
  type ProjectPersonWire,
} from "./people";
import { OwnerPill, PeopleChip, RoleLine } from "./PeopleMarks";

/**
 * The people marks: who an item belongs to and how a project is shared,
 * worked out from the reads alone (an owner, a role, a project's people)
 * and drawn as the chip, the corner pill and the role line.
 */

const ada = { name: "Ada Okafor", sqlName: "ada" };
const person = (name: string, sqlName: string, role: ProjectPersonWire["role"]): ProjectPersonWire =>
  ({ name, sqlName, role, deactivated: false });

describe("the people words", () => {
  it("takes a mark's letters from the first and last word of a name", () => {
    expect(initials("Ada Okafor")).toBe("AO");
    expect(initials("  bo  ")).toBe("B");
    expect(initials("Cy de la Marsh")).toBe("CM");
    expect(initials("")).toBe("?");
  });

  it("speaks of a person by their first name", () => {
    expect(firstName("Ada Okafor")).toBe("Ada");
    expect(firstName("bo")).toBe("bo");
  });

  it("names who a project is shared with in a sentence", () => {
    expect(sharedWithLine(["Bo Lindqvist"])).toBe("Shared with Bo");
    expect(sharedWithLine(["Bo Lindqvist", "Cy Marsh"])).toBe("Shared with Bo and Cy");
    expect(sharedWithLine(["Bo", "Cy", "Dee"])).toBe("Shared with Bo, Cy and Dee");
  });

  it("marks only what someone else owns, and nothing while the reader is unknown", () => {
    expect(ownedByOther(ada, "bo")).toBe(true);
    expect(ownedByOther(ada, "ada")).toBe(false);
    expect(ownedByOther(ada, null)).toBe(false);
    expect(ownedByOther(undefined, "bo")).toBe(false);
  });

  it("counts a shared project's people for its owner, never the owner", () => {
    const people = [person("Ada Okafor", "ada", "owner"), person("Bo Lindqvist", "bo", "editor"), person("Cy Marsh", "cy", "viewer")];
    expect(peopleMark({ role: "owner", owner: ada }, people)).toEqual({
      kind: "sharing", count: 2, title: "Shared with Bo and Cy",
    });
  });

  it("marks nothing on a project only its owner reaches, or before its people are read", () => {
    expect(peopleMark({ role: "owner", owner: ada }, [person("Ada Okafor", "ada", "owner")])).toBeNull();
    expect(peopleMark({ role: "owner", owner: ada }, null)).toBeNull();
    expect(peopleMark({ owner: ada }, undefined)).toBeNull();
  });

  it("says whose a project shared with one is and one's role", () => {
    expect(peopleMark({ role: "editor", owner: ada }, null)).toEqual({ kind: "shared", owner: "Ada", role: "Editor" });
    expect(peopleMark({ role: "viewer", owner: ada }, null)).toEqual({ kind: "shared", owner: "Ada", role: "Viewer" });
  });
});

describe("the people marks", () => {
  it("draws the chip with the people glyph and a count, naming the people on hover", () => {
    const html = renderToStaticMarkup(<PeopleChip mark={{ kind: "sharing", count: 2, title: "Shared with Bo and Cy" }} />);
    expect(html).toContain('data-people="sharing"');
    expect(html).toContain('data-hint="Shared with Bo and Cy"');
    expect(html).toContain('aria-label="Shared with Bo and Cy"');
    expect(html).toContain("<svg");
    expect(html).toMatch(/>2<\/span>/);
  });

  it("draws the chip on a project shared with one as the owner and the role", () => {
    const html = renderToStaticMarkup(<PeopleChip mark={{ kind: "shared", owner: "Ada", role: "Viewer" }} />);
    expect(html).toContain('data-people="shared"');
    expect(html).toContain("by Ada · Viewer");
    expect(html).not.toContain("data-hint");
  });

  it("draws nothing for no mark", () => {
    expect(renderToStaticMarkup(<PeopleChip mark={null} />)).toBe("");
  });

  it("draws the corner pill with the owner's initials and their name on hover", () => {
    const html = renderToStaticMarkup(<OwnerPill owner={ada} placement="corner" />);
    expect(html).toContain('data-placement="corner"');
    expect(html).toContain('data-hint="Shared by Ada Okafor"');
    expect(html).toContain('aria-label="Shared by Ada Okafor"');
    expect(html).toContain(">AO<");
    // The initials are visible words; the hover must still name the owner.
    expect(html).toContain("data-hint-ignore-text");
  });

  it("draws the owner's picture in the pill by its version, over the first and last initials until it loads", () => {
    const owner = { name: "Ada Byron Okafor", sqlName: "ada", pictureVersion: "p1" };
    for (const placement of ["corner", "inline", "path"] as const) {
      const html = renderToStaticMarkup(<OwnerPill owner={owner} placement={placement} />);
      expect(html, placement).toContain('src="/api/accounts/ada/picture?v=p1"');
      expect(html, placement).toContain(">AO<");
      expect(html, placement).toContain('aria-label="Shared by Ada Byron Okafor"');
    }
  });

  it("asks for no picture of an owner who has none", () => {
    expect(renderToStaticMarkup(<OwnerPill owner={ada} placement="corner" />)).not.toContain("<img");
    expect(renderToStaticMarkup(<RoleLine owner={ada} role="viewer" />)).not.toContain("<img");
  });

  it("draws the owner's picture on the role line by its version", () => {
    const html = renderToStaticMarkup(<RoleLine owner={{ ...ada, pictureVersion: "p2" }} role="viewer" />);
    expect(html).toContain('src="/api/accounts/ada/picture?v=p2"');
    expect(html).toContain(">AO<");
    expect(html).toContain("<b>Viewer</b> · Ada Okafor’s project");
  });

  it("draws the shared project's role line with the owner's initials and whose project it is", () => {
    const html = renderToStaticMarkup(<RoleLine owner={ada} role="editor" />);
    expect(html).toContain('data-role-line="editor"');
    expect(html).toContain(">AO<");
    expect(html).toContain("<b>Editor</b> · Ada Okafor’s project");
    expect(html).not.toContain("—");
  });
});
