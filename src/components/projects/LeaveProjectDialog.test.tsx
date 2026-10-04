import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostEvent, installDomHost } from "../testing/dom-host";
import { LeaveProjectDialog, ownsFiledWork } from "./LeaveProjectDialog";

vi.mock("../shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));
let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>;
const done = vi.fn();
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  done.mockClear();
  fetcher = vi.fn(async () => Response.json({ left: true }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });
function Harness({ ownsWork }: { ownsWork: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Opener</button>{open && <LeaveProjectDialog
    projectId="P" projectName="Survey" ownsWork={ownsWork} onClose={() => setOpen(false)} onDone={done} />}</>;
}
const button = (text: string) => host.document.querySelectorAll("button").find(b => b.textContent === text)!;
const click = async (text: string) => act(async () => { button(text).click(); });
const dialog = () => host.document.querySelector('[role="dialog"]');
async function open(ownsWork = true) {
  await act(async () => root.render(<Harness ownsWork={ownsWork} />));
  button("Opener").focus();
  await click("Opener");
}
it.each([false, true])("names retained filing only when there is owned work (%s)", async owns => {
  await open(owns);
  expect(dialog()?.textContent).toContain("You will no longer see this project or work you could access only through it. Its owner can add you again.");
  expect(dialog()?.textContent.includes("What you created here stays yours and stays in the project. You still find it in your own lists.")).toBe(owns);
  expect(button("Leave project").getAttribute("data-variant")).toBe("danger");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["Cancel", "Escape"])("%s makes no request and restores the opener", async action => {
  await open();
  expect(host.document.activeElement).toBe(dialog());
  if (action === "Cancel") await click(action);
  else await act(async () => host.document.dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })));
  expect(dialog()).toBeNull();
  expect(host.document.activeElement).toBe(button("Opener"));
  expect(fetcher).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
});
it("keeps a refusal in the dialog and never reports departure", async () => {
  fetcher.mockResolvedValue(Response.json({ error: { code: "not_found", message: "The requested resource was not found." } }, { status: 404 }));
  await open(); await click("Leave project");
  expect(host.document.querySelector('[role="alert"]')?.textContent).toContain("The requested resource was not found.");
  expect(dialog()).not.toBeNull(); expect(done).not.toHaveBeenCalled();
});
it("holds cancellation and duplicate submission while departure is pending", async () => {
  let release!: (response: Response) => void;
  fetcher.mockReturnValue(new Promise<Response>(resolve => { release = resolve; }));
  await open(); await click("Leave project"); await click("Leave project");
  expect(button("Cancel").disabled).toBe(true);
  await act(async () => host.document.dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })));
  expect(dialog()).not.toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith("/api/projects/P/leave", { method: "POST" });
  await act(async () => release(Response.json({ left: true })));
  expect(done).toHaveBeenCalledExactlyOnceWith("You left Survey.");
});
it("finds owned work of every filed kind, independently of the caller's role", () => {
  const world = { maps: [], workflows: [], tables: [] };
  for (const kind of ["maps", "workflows", "tables"]) {
    const filed = kind === "tables" ? { projectIds: ["P", "Q"] } : { projectId: "P" };
    const fixture = { ...world, [kind]: [{ ...filed, owner: { sqlName: "me" } }] };
    expect(ownsFiledWork(fixture, "P", "me")).toBe(true);
    expect(ownsFiledWork(fixture, "P", "other")).toBe(false);
    expect(ownsFiledWork(fixture, "missing", "me")).toBe(false);
    expect(ownsFiledWork(fixture, "P", null)).toBe(false);
  }
});
