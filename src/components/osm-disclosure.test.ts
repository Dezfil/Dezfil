import { describe, it, expect } from "vitest";
import {
  FORM_DRIVEN,
  acceptDisclosure,
  actionsDisabled,
  cancelDisclosure,
  editDraft,
  formDisabled,
  openDisclosure,
  regenerateDisclosure,
} from "./osm-disclosure";

/** The disclosure contract: only acceptance arms
 * the custom query; cancel restores what was in force; regenerate is
 * the road back to the form. */
describe("osm disclosure", () => {
  it("starts form-driven with everything enabled", () => {
    expect(FORM_DRIVEN.custom).toBeNull();
    expect(formDisabled(FORM_DRIVEN)).toBe(false);
    expect(actionsDisabled(FORM_DRIVEN)).toBe(false);
  });

  it("opens seeded from the generated query and disables form + actions", () => {
    const open = openDisclosure(FORM_DRIVEN, "out geom;");
    expect(open.draft).toBe("out geom;");
    expect(formDisabled(open)).toBe(true);
    expect(actionsDisabled(open)).toBe(true);
  });

  it("editing the draft never arms the custom query", () => {
    const open = editDraft(openDisclosure(FORM_DRIVEN, "a"), "edited");
    expect(open.custom).toBeNull();
  });

  it("accept arms the draft; the form stays detached, actions return", () => {
    const armed = acceptDisclosure(
      editDraft(openDisclosure(FORM_DRIVEN, "a"), "custom out;"),
    );
    expect(armed.custom).toBe("custom out;");
    expect(armed.open).toBe(false);
    expect(formDisabled(armed)).toBe(true);
    expect(actionsDisabled(armed)).toBe(false);
  });

  it("cancel from a form-driven session restores the form", () => {
    const closed = cancelDisclosure(
      editDraft(openDisclosure(FORM_DRIVEN, "a"), "scrapped"),
    );
    expect(closed).toEqual(FORM_DRIVEN);
  });

  it("cancel after an accepted custom keeps the custom in force", () => {
    const armed = acceptDisclosure(
      editDraft(openDisclosure(FORM_DRIVEN, "a"), "keep me"),
    );
    const reopened = openDisclosure(armed, "regenerated");
    expect(reopened.draft).toBe("keep me");
    const cancelled = cancelDisclosure(editDraft(reopened, "discard me"));
    expect(cancelled.custom).toBe("keep me");
    expect(cancelled.open).toBe(false);
  });

  it("regenerate returns fully to the form", () => {
    expect(regenerateDisclosure()).toEqual(FORM_DRIVEN);
  });
});
