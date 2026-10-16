import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DataTable } from "./api";
import { CRS_DOOR_TIP, CRS_DOOR_TIP_ACTION, CrsChip, isRefreshableImport, SourceChip, sourceLabel, sourceTitle } from "./table-chips";

const table: DataTable = {
  id: "t", name: "trips", sourceFilename: "trips.csv", format: "csv", file: "tables/t.parquet", geometryColumn: "geometry", geometryType: "LINESTRING",
  crsAssumed: true, headerSuspect: false, rowCount: 10, createdAt: "2026-09-13T10:00:00Z", source: "upload", sourceParams: null, importedAt: null,
};

describe("the assumed-CRS chip as a door", () => {
  it("with a door it is a button with the caret and the drawn tooltip's two lines; the chip follows the assumption flag", () => {
    const html = renderToStaticMarkup(<CrsChip table={table} onOpen={() => {}} />);
    expect(html).toMatch(/<button[^>]*data-set-geometry-door="crs"[^>]*>WGS84 assumed<svg/);
    expect(html).toContain('role="tooltip"');
    expect(html).toContain(CRS_DOOR_TIP);
    expect(html).toContain(`<small>${CRS_DOOR_TIP_ACTION}</small>`);
    expect(renderToStaticMarkup(<CrsChip table={{ ...table, crsAssumed: false }} onOpen={() => {}} />)).toBe("");
  });
  it("without a door, as the cards and rows render it, it is the shipped chip: no button, no caret, the native title", () => {
    const html = renderToStaticMarkup(<CrsChip table={table} />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data-set-geometry-door");
    expect(html).toContain('title="The file declared no CRS; WGS84 was assumed"');
    expect(html).toContain(">WGS84 assumed<");
  });
});

describe("the door's drawn tooltip, read from the stylesheet", () => {
  // The tooltip stands below the chip, over whatever sits there (the
  // preview tabs on the dataset page). A click on the chip leaves focus on
  // it, so a tooltip held open by any focus, and hit-testable, keeps
  // catching the next click meant for what it covers.
  const sheet = readFileSync("src/components/gallery.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((s) => s.trim()),
    body: m[2],
  }));
  const showing = rules
    .filter((r) => /visibility:\s*visible/.test(r.body))
    .flatMap((r) => r.selectors)
    .filter((s) => /\.tip$/.test(s));

  it("never takes the pointer, so a click beside the chip reaches what the tooltip covers", () => {
    const tip = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === ".tip");
    expect(tip, "the tooltip's own rule").toBeDefined();
    expect(tip!.body).toMatch(/pointer-events:\s*none/);
  });

  it("shows on hover and on keyboard focus, and a click's focus does not hold it open", () => {
    expect(showing.some((s) => s.includes(":hover")), "a hover shows it").toBe(true);
    expect(showing.some((s) => s.includes(":focus-visible")), "keyboard focus shows it").toBe(true);
    for (const selector of showing) expect(selector, "only keyboard focus counts").not.toMatch(/:focus(?!-visible)/);
  });
});

describe("the chip on the Data page's cards and rows stays as shipped", () => {
  it("neither the card nor the row renders the door", async () => {
    const { TableCard, TableRow } = await import("./data-cards");
    const listing = { ...table, sizeBytes: 100, projectIds: [], owner: { name: "Ada", sqlName: "ada" }, qualifiedName: "trips" };
    const actions = { table: listing, confirming: false, deleting: false, onOpen() {}, onQuery() {}, onAddToMap() {}, onFile() {}, onDeletePress() {}, onDeleteBlur() {}, onDeleteConfirm() {}, onDeleteCancel() {}, onDownload() {} } as unknown as Parameters<typeof TableCard>[0]["actions"];
    const card = renderToStaticMarkup(<TableCard table={listing} index={0} actions={actions} />);
    expect(card).toContain(">WGS84 assumed<");
    expect(card).not.toContain("data-set-geometry-door");
    const row = renderToStaticMarkup(<table><tbody><TableRow table={listing} actions={actions} /></tbody></table>);
    expect(row).toContain("WGS84 assumed");
    expect(row).not.toContain("data-set-geometry-door");
  });
});

describe("a dataset a copy of a template made", () => {
  const copied: DataTable = { ...table, source: "template", sourceFilename: null, sourceParams: { template: "harbour-stations", version: 2 } };
  it("says where it came from, by the template and its version, and offers no refresh", () => {
    expect(sourceLabel(copied)).toBe("From a template");
    expect(sourceTitle(copied)).toBe("Copied from the template harbour-stations, version 2");
    expect(sourceTitle({ ...copied, sourceParams: null })).toBe("Copied from a template");
    expect(isRefreshableImport(copied)).toBe(false);
    expect(renderToStaticMarkup(<SourceChip table={copied} />)).toContain("From a template");
  });
});
