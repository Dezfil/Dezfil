import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectHomeScreen } from "./ProjectHomeScreen";
import { ProjectHomeReader } from "./home-reader";
import { useProjectHome, type ProjectRecordWire } from "./home-read";
import { invalidateProjects } from "../shell/use-project-name";

const crumb = vi.hoisted(() => ({
  onRename: (name: string): void => { throw new Error(`No rendered rename callback for ${name}`); },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./home-read", async (original) => ({
  ...await original<typeof import("./home-read")>(),
  useProjectHome: vi.fn(),
}));
vi.mock("../shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));
vi.mock("../shell/ProjectCrumbTail", () => ({
  ProjectCrumbTail: ({ onRename }: { onRename: (name: string) => void }) => {
    crumb.onRename = onRename;
    return null;
  },
}));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("../use-upload-queue", () => ({ useUploadQueue: () => ({}) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("project-home mutation cache", () => {
  it("invalidates a successful rename after its issuing visit is disposed", async () => {
    const record: ProjectRecordWire = {
      id: "a", name: "Original", note: null,
      createdAt: "2026-09-06T10:00:00.000Z", updatedAt: "2026-09-06T10:00:00.000Z",
    };
    const reader = new ProjectHomeReader(async () => ({
      status: "ready", value: {
        record, maps: [], workflows: [], tables: [], names: new Map(), lastRuns: new Map(),
      },
    }));
    const visit = { id: "a" };
    await reader.activate(visit);
    const acceptSave = vi.spyOn(reader, "acceptSave");
    // Inject the real coordinator at the hook boundary. React and the screen's
    // rename callback are real; the crumb only exposes the callback to drive.
    vi.mocked(useProjectHome).mockReturnValue({
      state: reader.getSnapshot().state,
      retry: () => { void reader.retry(visit); },
      refresh: () => reader.refresh(visit),
      confirmMembership: () => reader.confirmMembership(visit),
      beginAction: () => reader.beginAction(visit),
      ownsAction: (action) => reader.ownsAction(action),
      beginSave: (field) => reader.beginSave(visit, field),
      ownsSave: (save) => reader.ownsSave(save),
      acceptSave: (save, reply) => reader.acceptSave(save, reply),
    });
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    renderToStaticMarkup(<ProjectHomeScreen id="a" />);
    crumb.onRename("Saved new name");
    expect(fetcher).toHaveBeenCalledWith("/api/projects/a", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ name: "Saved new name" }),
    }));
    expect(invalidateProjects).not.toHaveBeenCalled();
    reader.dispose(visit);
    release(Response.json({ ...record, name: "Saved new name" }));
    // Await the actual continuation, including its rejected local install,
    // before asserting the global side effect. No copied mutation logic.
    await vi.waitFor(() => expect(acceptSave).toHaveReturnedWith(false));
    expect(invalidateProjects).toHaveBeenCalledOnce();
    expect(reader.getSnapshot()).toEqual({ visit: null, state: { status: "pending" } });
  });
});
