import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { FailedLayers } from "./FailedLayers";

/**
 * The published link's failure note: each layer it cannot draw, by name,
 * with the reader's line. A layer whose SQL reads more than the link
 * publishes says so in one short sentence, and since that refusal is the
 * same on every try, the note offers no Retry for it; a failure a retry
 * could clear keeps Retry.
 */

const catalogue = { code: "catalogue_not_published", message: ERROR_CATALOGUE.catalogue_not_published };
const transient = { code: "internal", message: "The layer could not render." };
const note = (layers: { id: string; name: string; failure: typeof catalogue | null }[]) =>
  renderToStaticMarkup(<FailedLayers layers={layers} onRetry={vi.fn()} />);

describe("the published link's failure note", () => {
  it("says a layer reading more than the link publishes in one short sentence", () => {
    const html = note([{ id: "l1", name: "Catalogue probe", failure: catalogue }]);
    expect(html).toContain("“Catalogue probe” unavailable: It reads data this link does not publish.");
    expect(html).not.toContain("instance");
  });

  it("offers no Retry on that refusal, which is the same on every try", () => {
    expect(note([{ id: "l1", name: "Catalogue probe", failure: catalogue }])).not.toContain("data-layer-retry");
  });

  it("keeps Retry while any failure could clear on another try", () => {
    expect(note([{ id: "l2", name: "Roads", failure: transient }])).toContain("data-layer-retry");
    expect(note([{ id: "l1", name: "Catalogue probe", failure: catalogue }, { id: "l2", name: "Roads", failure: transient }]))
      .toContain("data-layer-retry");
  });

  it("draws nothing when every layer draws", () => {
    expect(note([])).toBe("");
  });
});
