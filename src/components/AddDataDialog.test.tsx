import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AddDataDialog } from "./AddDataDialog";
import type { UploadQueue } from "./use-upload-queue";

/**
 * The Add data dialog's Files surface as markup (task 3): the net
 * under which its Files pane is extracted, written before the
 * extraction and held across it. The kit's Dialog portals into the
 * document, which the node suite has none of, so it is a plain box here;
 * the map-based panes are stubs, since only the Files surface is under
 * the net.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./shell/use-project-name", () => ({ useProjectName: (id: string | null) => (id === "p-berlin" ? "Berlin" : null) }));
vi.mock("./ui/Dialog", () => ({
  Dialog: ({ label, className, children, ...data }: { label: string; className?: string; children: ReactNode } & Record<string, unknown>) => (
    <div role="dialog" aria-label={label} className={className} {...data}>{children}</div>
  ),
}));
vi.mock("./OverturePane", () => ({ OverturePane: () => <div data-pane="overture" /> }));
vi.mock("./OsmPane", () => ({ OsmPane: () => <div data-pane="osm" /> }));
vi.mock("./connections/PostgisPane", () => ({ PostgisPane: () => <div data-pane="postgis" /> }));

export function fakeQueue(over: Partial<UploadQueue> = {}): UploadQueue {
  return {
    entries: [], projectId: null, active: null, settled: false, position: 1, skips: [], batch: 0, matching: null,
    add: vi.fn(), dismiss: vi.fn(() => 0), reset: vi.fn(), current: vi.fn(), registerMatchingGate: vi.fn(() => () => {}), resolveMatching: vi.fn(),
    ...over,
  };
}

const html = (props: Partial<Parameters<typeof AddDataDialog>[0]> = {}) =>
  renderToStaticMarkup(
    <AddDataDialog open onClose={vi.fn()} onTableCreated={vi.fn()} onPostgisTableCreated={vi.fn()} uploadQueue={fakeQueue()} {...props} />,
  );
const text = (h: string) => h.replace(/<[^>]+>/g, "");

describe("the Add data dialog's Files surface (as shipped)", () => {
  it("opens on Files with the two tabs in the header, the close control, the zone and its one hint, in that order", () => {
    const h = html();
    expect(h).toContain('aria-label="Add data"');
    expect(h).not.toContain("data-wide");
    expect(h).toContain('role="tablist"');
    expect(text(h)).toContain("Upload file");
    expect(text(h)).toContain("From URL");
    expect(h).toContain('aria-label="Close"');
    expect(h).toContain('aria-label="Upload data files"');
    expect(text(h)).toContain("A file with several layers lands as one table each.");
    const at = (s: string) => h.indexOf(s);
    expect(at('role="tablist"')).toBeLessThan(at('aria-label="Close"'));
    expect(at('aria-label="Close"')).toBeLessThan(at('aria-label="Upload data files"'));
    expect(at('aria-label="Upload data files"')).toBeLessThan(at("A file with several layers"));
    // The four sources in the nav, Files current.
    expect(h.match(/aria-current="true"/g)).toHaveLength(1);
    expect(h.match(/aria-current="false"/g)).toHaveLength(3);
  });
  it("closed, it renders nothing", () => {
    expect(html({ open: false })).toBe("");
  });
  it("says where imports land when the host has a project, and nothing when it has none", () => {
    expect(text(html({ projectId: "p-berlin", projectName: "Berlin" }))).toContain("Imported datasets join Berlin.");
    expect(text(html({ projectId: "p-berlin" }))).toContain("Imported datasets join Berlin.");
    expect(text(html())).not.toContain("Imported datasets join");
  });
  it("names the running batch's own destination when the host's scope has moved since admission (the)", () => {
    const running = fakeQueue({ entries: [{ id: 1, name: "a.csv", state: "uploading", progress: 0.2, error: null }], active: 0, projectId: null });
    expect(text(html({ projectId: "p-berlin", projectName: "Berlin", uploadQueue: running }))).toContain("Files added now join this batch, which files into no project.");
    const filed = fakeQueue({ ...running, projectId: "p-berlin" });
    expect(text(html({ projectId: null, uploadQueue: filed }))).toContain("Files added now join this batch, which files into Berlin.");
  });
  it("opens on PostGIS when a connection is handed in, with the wide form and that pane's title", () => {
    const h = html({ initialPostgisConnectionId: "c-7" });
    expect(h).toContain("data-wide");
    expect(h).toContain('data-pane="postgis"');
    expect(text(h)).toContain("PostGIS");
    expect(h).not.toContain('role="tablist"');
  });
});

/** The step in the dialog: shown on Files in place of the
 * pane, in the wide form with the header naming the step and the file;
 * on another source it is not shown and not resolved (the  * placeholder). The step's state is the hook's, stubbed here. */
vi.mock("./column-matching/use-matching-step", () => ({
  useMatchingStep: () => ({
    state: { panel: { phase: "opening", openError: null, inspection: null, choice: { format: "pair", columns: [], projection: { kind: "implicit", code: null, text: "" } }, mode: "first", marked: false, preview: { status: "idle", key: null, answer: null, answerKey: null, answerRecord: null, message: null }, applying: false, rereading: false, refusal: null }, confirmable: false, busy: false, resolved: null },
    step: { getState: vi.fn(), subscribe: () => () => {}, controller: {}, configure: vi.fn(), open: vi.fn(), confirm: vi.fn(), cancel: vi.fn() },
  }),
}));
const held = {
  id: "t1", name: "weak_pair", sourceFilename: "weak_pair.csv", format: "csv" as const, file: "tables/t1.parquet",
  geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 3,
  createdAt: "2026-09-13T10:00:00Z", source: "upload" as const, sourceParams: null, importedAt: "2026-09-13T10:00:00Z", geometryRecord: null, geometryCandidates: [],
};
describe("the column-matching step inside the dialog", () => {
  it("on Files a pending step takes the pane's place in the wide form, the header naming the step and the file, the note naming what waits", () => {
    const h = html({ uploadQueue: fakeQueue({ entries: [{ id: 1, name: "weak_pair.csv", state: "matching", progress: 1, error: null }], matching: { id: 1, name: "weak_pair.csv", table: held, waiting: ["b.csv"] } }) });
    expect(h).toContain("data-wide");
    expect(text(h)).toContain("Column matching");
    expect(text(h)).toContain("weak_pair.csv");
    expect(h).toContain('aria-label="Close"');
    expect(h).not.toContain('role="tablist"');
    expect(h).not.toContain('aria-label="Upload data files"');
    expect(text(h)).toContain("1 more file waits for this step: b.csv");
    expect(text(h)).toContain("Confirm");
  });
  it("on another source the pending step is not shown; the source's own header and pane stand", () => {
    const h = html({ initialPostgisConnectionId: "c-7", uploadQueue: fakeQueue({ entries: [{ id: 1, name: "weak_pair.csv", state: "matching", progress: 1, error: null }], matching: { id: 1, name: "weak_pair.csv", table: held, waiting: [] } }) });
    expect(text(h)).not.toContain("Column matching");
    expect(text(h)).not.toContain("Confirm");
    expect(h).toContain('data-pane="postgis"');
    expect(h).toContain("data-wide");
  });
});
