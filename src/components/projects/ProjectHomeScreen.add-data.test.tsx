import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignedIn } from "../sharing/signed-in";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { ProjectHomeScreen } from "./ProjectHomeScreen";

/**
 * An empty project's Add data, closed as the Data page closes it: the
 * files not started are stopped and said, a settled batch is cleared so
 * the next open never shows its old notes, and a batch that settles
 * after the close is said on the home, the only account of it left. The
 * dialog and the queue are their own surfaces, held by their own tests:
 * here they record what the home hands them.
 */

const hosted = vi.hoisted(() => ({
  addData: null as null | {
    open: boolean;
    projectId?: string | null;
    onTableCreated: (table: unknown) => void;
    onClose: () => void;
  },
  queue: null as null | { projectId?: string | null; onSettled?: (report: unknown) => void },
  resets: 0,
  dismisses: 0,
  upload: { settled: true, stopped: 0 },
  confirms: 0,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/p1" }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("../builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("../shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));
vi.mock("../shell/ProjectCrumbTail", () => ({ ProjectCrumbTail: () => null }));
vi.mock("../sharing/MembersLine", () => ({ MembersLine: () => null }));
vi.mock("./home-read", async (original) => ({
  ...await original<typeof import("./home-read")>(),
  useProjectHome: () => ({
    state: { status: "ready", value: {
      record: { id: "p1", name: "Field tests", note: null, role: "owner", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
      maps: [], workflows: [], tables: [], names: new Map(), lastRuns: new Map(),
    } },
    retry: vi.fn(), refresh: vi.fn(async () => true),
    confirmMembership: vi.fn(async () => { hosted.confirms += 1; return true; }),
    beginAction: () => ({}), ownsAction: () => true, beginSave: () => ({}), ownsSave: () => true, acceptSave: () => true,
  }),
  useCatalogue: () => ({ state: { status: "ready", value: { maps: [], workflows: [], tables: [] } }, reload: vi.fn(), retry: vi.fn() }),
}));
vi.mock("../AddDataDialog", () => ({
  AddDataDialog: (props: NonNullable<typeof hosted.addData>) => {
    hosted.addData = props;
    return props.open ? <div data-add-data-dialog /> : null;
  },
}));
vi.mock("../use-upload-queue", () => ({
  useUploadQueue: (options: NonNullable<typeof hosted.queue>) => {
    hosted.queue = options;
    return {
      entries: [], settled: hosted.upload.settled, projectId: "p1",
      dismiss: () => { hosted.dismisses += 1; return hosted.upload.stopped; },
      reset: () => { hosted.resets += 1; },
      current: () => ({ settled: hosted.upload.settled }),
    };
  },
}));

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  hosted.addData = null;
  hosted.queue = null;
  hosted.resets = 0;
  hosted.dismisses = 0;
  hosted.upload = { settled: true, stopped: 0 };
  hosted.confirms = 0;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })));
  host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});

afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(
    <SignedIn account={{ name: "Ada Lovelace", sqlName: "ada" }}><ProjectHomeScreen id="p1" files /></SignedIn>,
  ));
  await settle();
}
async function press(element: HostElement) {
  await act(async () => { element.click(); });
  await settle();
}
const addData = () => container.querySelectorAll("button").find((b) => b.textContent?.includes("Add data"))!;
const notices = () => container.querySelectorAll('[role="status"]').map((n) => n.textContent);
const report = (over: Record<string, unknown>) => ({
  files: 1, imported: 0, failed: 0, unconfirmed: 0, notStarted: 0, entries: [], tables: [], skips: [], dismissed: false, batch: 1, ...over,
});

describe("an empty project's Add data", () => {
  it("files the upload into the project", async () => {
    await open();
    expect(hosted.queue?.projectId).toBe("p1");
    await press(addData());
    expect(hosted.addData?.open).toBe(true);
    expect(hosted.addData?.projectId).toBe("p1");
  });

  it("closes as the Data page does: a settled batch cleared, the files not started stopped and said", async () => {
    await open();
    // A batch settled while open, its notes in the dialog: closing clears
    // it, so the next open never shows them again.
    await press(addData());
    await act(async () => { hosted.addData!.onClose(); });
    await settle();
    expect(hosted.addData?.open).toBe(false);
    expect([hosted.dismisses, hosted.resets]).toEqual([1, 1]);
    expect(notices()).toEqual([]);
    // Closed while a file uploads and two wait: the two are stopped and
    // said; the running batch is not cleared.
    await press(addData());
    hosted.upload = { settled: false, stopped: 2 };
    await act(async () => { hosted.addData!.onClose(); });
    await settle();
    expect([hosted.dismisses, hosted.resets]).toEqual([2, 1]);
    expect(notices()).toEqual(["Stopped. 2 queued files were not started."]);
    // A table landing from another source closes it the same way; one
    // stopped file is said in the singular.
    await press(addData());
    hosted.upload = { settled: false, stopped: 1 };
    await act(async () => { hosted.addData!.onTableCreated({ name: "stations" }); });
    await settle();
    expect(hosted.addData?.open).toBe(false);
    expect([hosted.dismisses, hosted.resets]).toEqual([3, 1]);
    expect(notices()).toEqual(["Stopped. 1 queued file was not started."]);
  });

  it("says how an upload ended when Add data was closed during it, and clears the settled batch", async () => {
    await open();
    // Open, the dialog keeps a batch that did not land cleanly, its notes
    // readable there: nothing is said on the home, nothing cleared.
    await press(addData());
    await act(async () => {
      hosted.queue!.onSettled!(report({ files: 2, imported: 1, failed: 1, tables: [{ name: "stations" }], entries: [{ name: "stations.csv", state: "imported" }, { name: "broken.csv", state: "failed" }] }));
    });
    await settle();
    expect(hosted.addData?.open).toBe(true);
    expect(notices()).toEqual([]);
    expect(hosted.resets).toBe(0);
    // Closed during the next upload: how it ended is said on the home once
    // it settles, and the settled batch is cleared.
    hosted.upload = { settled: false, stopped: 0 };
    await act(async () => { hosted.addData!.onClose(); });
    await settle();
    expect(hosted.addData?.open).toBe(false);
    await act(async () => {
      hosted.queue!.onSettled!(report({
        files: 3, imported: 1, failed: 1, unconfirmed: 1, tables: [{ name: "parcels" }],
        entries: [{ name: "parcels.gpkg", state: "imported" }, { name: "roads.csv", state: "failed" }, { name: "rivers.zip", state: "unconfirmed" }],
      }));
    });
    await settle();
    expect(notices()).toEqual(["1 table ready. · roads.csv could not be imported · rivers.zip unconfirmed, check the listing"]);
    expect(hosted.resets).toBe(1);
    // A clean batch settling after the close is said too.
    await act(async () => {
      hosted.queue!.onSettled!(report({ imported: 1, tables: [{ name: "wells" }], entries: [{ name: "wells.csv", state: "imported" }] }));
    });
    await settle();
    expect(notices()).toEqual(["wells is ready."]);
    expect(hosted.resets).toBe(2);
  });
});
