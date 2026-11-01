import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddDataDialog } from "./AddDataDialog";
import { HostEvent, installDomHost, type HostElement } from "./testing/dom-host";
import { useStorageFullLine } from "./use-instance-rules";
import type { UploadQueue } from "./use-upload-queue";

/**
 * The one line a person sees while the instance's storage is full, from the
 * runtime read: its words, that it goes when the read says space is back, and
 * that the latest answer stands when two return out of order. The read is a
 * fake that a test answers in the order it chooses.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./shell/use-project-name", () => ({ useProjectName: () => null }));
vi.mock("./ui/Dialog", () => ({
  Dialog: ({ label, children }: { label: string; children: ReactNode }) => <div role="dialog" aria-label={label}>{children}</div>,
}));
vi.mock("./OverturePane", () => ({ OverturePane: () => <div data-pane="overture" /> }));
vi.mock("./OsmPane", () => ({ OsmPane: () => <div data-pane="osm" /> }));
vi.mock("./connections/PostgisPane", () => ({ PostgisPane: () => <div data-pane="postgis" /> }));

const MB = 1024 * 1024;
const full = (free: number) => ({ storage: { full: true, free: free * MB, total: 20480 * MB, threshold: 512 * MB } });
const room = { storage: { full: false, free: 4096 * MB, total: 20480 * MB, threshold: 512 * MB } };
const FAILED = Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 });

/** One entry per read in flight, oldest first. */
let waiting: ((answer: Response | object) => void)[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  waiting = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url !== "/api/config") return Promise.resolve(Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 }));
    return new Promise<Response>(resolve => waiting.push(answer => resolve(answer instanceof Response ? answer.clone() : Response.json(answer))));
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function answer(at: number, body: Response | object) {
  const [respond] = waiting.splice(at, 1);
  await act(async () => { respond(body); await new Promise(resolve => setTimeout(resolve, 0)); });
}
const comeBack = () => act(async () => { window.dispatchEvent(new HostEvent("focus") as unknown as Event); });

function Line({ revision }: { revision: string }) {
  const line = useStorageFullLine(revision);
  return line ? <p role="status">{line}</p> : null;
}
const show = (revision = "a") => act(async () => root.render(<Line revision={revision} />));
const said = () => container.querySelectorAll('[role="status"]').map(element => element.textContent);

describe("the storage line", () => {
  it("says what is free while the read says full, in whole MB, and nothing otherwise", async () => {
    await show();
    expect(said()).toEqual([]);
    await answer(0, full(412));
    expect(said()).toEqual(["Storage is full: 412 MB free."]);
    await show("b");
    await answer(0, full(0));
    expect(said()).toEqual(["Storage is full: 0 MB free."]);
    await show("c");
    await answer(0, room);
    expect(said()).toEqual([]);
  });

  it("draws nothing when the read fails or does not carry the state", async () => {
    await show();
    await answer(0, FAILED);
    expect(said()).toEqual([]);
    await show("b");
    await answer(0, { rules: {} });
    expect(said()).toEqual([]);
  });

  it("reads again when the page moves and when the person comes back to the tab, and goes once space is back", async () => {
    await show();
    await answer(0, full(100));
    expect(waiting).toHaveLength(0);
    await show("a");
    expect(waiting).toHaveLength(0);
    await comeBack();
    expect(waiting).toHaveLength(1);
    await answer(0, full(90));
    expect(said()).toEqual(["Storage is full: 90 MB free."]);
    await show("b");
    expect(waiting).toHaveLength(1);
    await answer(0, room);
    expect(said()).toEqual([]);
  });

  it("keeps what it knows when a later read fails", async () => {
    await show();
    await answer(0, full(100));
    await comeBack();
    await answer(0, FAILED);
    expect(said()).toEqual(["Storage is full: 100 MB free."]);
  });

  it("keeps the latest answer when an earlier read returns after it", async () => {
    await show();
    await comeBack();
    expect(waiting).toHaveLength(2);
    await answer(1, room);
    expect(said()).toEqual([]);
    await answer(0, full(10));
    expect(said()).toEqual([]);
  });

  it("drops a read asked before the page moved", async () => {
    await show();
    await show("b");
    expect(waiting).toHaveLength(2);
    await answer(1, full(10));
    await answer(0, room);
    expect(said()).toEqual(["Storage is full: 10 MB free."]);
  });
});

describe("the Add data dialog's storage line", () => {
  const queue = (over: Partial<UploadQueue> = {}): UploadQueue => ({
    entries: [], projectId: null, active: null, settled: false, position: 1, skips: [], batch: 0, matching: null,
    add: vi.fn(), dismiss: vi.fn(() => 0), reset: vi.fn(), current: vi.fn(), registerMatchingGate: vi.fn(() => () => {}), resolveMatching: vi.fn(),
    ...over,
  });
  const dialog = (uploadQueue: UploadQueue) => act(async () => root.render(
    <AddDataDialog open onClose={vi.fn()} onTableCreated={vi.fn()} onPostgisTableCreated={vi.fn()} uploadQueue={uploadQueue} />,
  ));
  const line = () => container.querySelectorAll("p").map(element => element.textContent).filter(words => words.startsWith("Storage is full"));
  const source = (name: string) => act(async () => { container.querySelectorAll("button").find(button => button.textContent!.startsWith(name))!.click(); });

  it("shows the line while full, on every source, and not otherwise", async () => {
    await dialog(queue());
    await answer(0, full(412));
    expect(line()).toEqual(["Storage is full: 412 MB free."]);
    for (const name of ["Overture", "OpenStreetMap", "PostGIS", "Files"]) {
      await source(name);
      expect(line(), name).toEqual(["Storage is full: 412 MB free."]);
    }
    await comeBack();
    await answer(0, room);
    expect(line()).toEqual([]);
  });

  it("does not read while closed, and reads when an upload batch settles", async () => {
    await act(async () => root.render(<AddDataDialog open={false} onClose={vi.fn()} onTableCreated={vi.fn()} onPostgisTableCreated={vi.fn()} uploadQueue={queue()} />));
    expect(waiting).toHaveLength(0);
    await dialog(queue({ batch: 1, settled: false }));
    await answer(0, room);
    expect(line()).toEqual([]);
    await dialog(queue({ batch: 1, settled: true }));
    expect(waiting).toHaveLength(1);
    await answer(0, full(5));
    expect(line()).toEqual(["Storage is full: 5 MB free."]);
  });
});
