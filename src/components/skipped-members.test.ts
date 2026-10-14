import { expect, it } from "vitest";
import { withSkips } from "./skipped-members";
import { uploadSettleNotice } from "./upload-settle-notice";

const skip = { layer: "parcels.gpkg: styles", reason: "no geometry" };

it("joins a notice and its skipped members with one sentence end", () => {
  expect(withSkips("wells is ready.", [skip])).toBe("wells is ready. Skipped 1 member: parcels.gpkg: styles (no geometry)");
  expect(withSkips("1 table ready. · roads.csv could not be imported", [skip])).toBe(
    "1 table ready. · roads.csv could not be imported. Skipped 1 member: parcels.gpkg: styles (no geometry)",
  );
  // Nothing else to say: the skipped members alone, with no stray stop.
  expect(withSkips("", [skip])).toBe("Skipped 1 member: parcels.gpkg: styles (no geometry)");
  expect(withSkips("wells is ready.", null)).toBe("wells is ready.");
});

it("says a lone file's table with its skipped members as one sentence each", () => {
  const { text } = uploadSettleNotice({
    files: 1, imported: 1, failed: 0, unconfirmed: 0, notStarted: 0, dismissed: false, batch: 1,
    entries: [{ id: 1, name: "parcels.gpkg", state: "imported", progress: 1, error: null }],
    tables: [{ name: "parcels" } as Parameters<typeof uploadSettleNotice>[0]["tables"][number]],
    skips: [{ source: "parcels.gpkg", layer: "styles", reason: "no geometry" }],
  });
  expect(text).toBe("parcels is ready. Skipped 1 member: parcels.gpkg: styles (no geometry)");
});
