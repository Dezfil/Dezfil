import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateDetail } from "@/lib/templates/card";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { TemplateCopyDialog } from "./TemplateCopyDialog";

/**
 * Make a copy: the dialog names the version it describes, proposes the
 * title as the project's name, says what comes, its size, whether it
 * downloads first and that the template stays as it is. Confirming acts
 * on that version and no other, whatever the index did while the dialog
 * stood: it downloads the version when absent, then copies it, both
 * naming it, and lands in the builder (a workflow example: on its
 * canvas). A refusal is said in the dialog, nothing landing.
 *
 * The server is a fake answering through fetch, its listing moved to a
 * newer version by the test; every request is kept.
 */

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }) }));

const HOW: TemplateDetail["howMade"] = {
  question: "Which stations are busy?",
  datasets: [
    { dataset: "stations", source: "Transit office", made: "Station points." },
    { dataset: "districts", source: "Transit office", made: "District outlines." },
  ],
  styling: ["Points."],
};
const detail = (more: Partial<TemplateDetail>): TemplateDetail => ({
  id: "harbour-stations", kind: "map", version: 1, title: "Harbour stations", question: "Where are the stations?",
  place: "Example City", tags: ["First map"], dataDate: "2024-05",
  sources: [{ name: "Transit office", licence: "CC-BY-4.0", credit: "Transit office" }], steps: null,
  origin: "shipped", installed: 1, listed: null, present: true, size: 2_400_000, picture: "kept", howMade: HOW, ...more,
});
const busy = (version: number, present: boolean) => detail({
  id: "busy-stations", kind: "workflow", version, title: version === 1 ? "Busy stations" : "Busy stations, renewed",
  origin: "catalogue", installed: present ? version : null, listed: version, present, size: 3 * 1024 * 1024,
  steps: [
    { id: "step-busy", operation: "sql_step", output: "busy_stations", reads: ["stations"] },
    { id: "step-rings", operation: "buffer", output: "station_rings", reads: ["busy_stations"] },
  ],
});
const LANDED = {
  project: { id: "project-9", name: "Copied" },
  members: { maps: [{ id: "map-9" }], recipes: [{ id: "recipe-9" }], tables: [] },
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
/** What the read of one answers now: the index moves when the test says. */
let listed: TemplateDetail;
let refuse: Partial<Record<"fetch" | "copy", { status: number; code: string; message: string }>>;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let closed: ReturnType<typeof vi.fn>;

beforeEach(() => {
  nav.push.mockReset();
  calls = [];
  refuse = {};
  listed = busy(1, false);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    const action = call.path.endsWith("/fetch") ? "fetch" : call.path.endsWith("/copy") ? "copy" : null;
    const refusal = action ? refuse[action] : undefined;
    if (refusal) return Response.json({ error: { code: refusal.code, message: refusal.message } }, { status: refusal.status });
    if (call.method === "GET" && call.path === `/api/templates/${listed.id}`) return Response.json(listed);
    if (action === "fetch") return Response.json({ id: listed.id, version: (call.body as { version: number }).version });
    if (action === "copy") return Response.json(LANDED, { status: 201 });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  closed = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function show(id: string, template: TemplateDetail | null = null) {
  await act(async () => root.render(
    <StrictMode><TemplateCopyDialog id={id} template={template} onClose={closed as unknown as () => void} /></StrictMode>,
  ));
  await settle();
}
const dialog = () => host.document.querySelector("[data-template-copy-dialog]")!;
const text = (selector: string) => dialog().querySelector(selector)?.textContent ?? null;
const input = () => dialog().querySelector("input")!;
function props(element: HostElement) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const type = (value: string) => act(async () => props(input()).onChange({ target: { value } }));
const button = (label: string) => dialog().querySelectorAll("button").find((b) => b.textContent?.includes(label))!;
async function confirm() {
  await act(async () => button("Make a copy").click());
  await settle();
}
const writes = () => calls.filter((c) => c.method !== "GET").map((c) => ({ path: c.path, body: c.body }));

describe("the copy dialog", () => {
  it("names the version it describes and says what comes, its size and that the template stays", async () => {
    await show("harbour-stations", detail({}));
    expect(text("strong")).toBe("Make a copy");
    expect(text("[data-copy-sub]")).toBe("Harbour stations, version 1, becomes yours in a new project.");
    expect(input().value).toBe("Harbour stations");
    expect(text("[data-copy-comes]")).toBe("Comes with 1 map and 2 datasets, 2.3 MB. The template stays as it is.");
    expect(calls).toEqual([]);
  });

  it("says a workflow example's workflow and results come too, and that an absent version downloads first", async () => {
    await show("busy-stations", busy(2, false));
    expect(text("[data-copy-sub]")).toBe("Busy stations, renewed, version 2, becomes yours in a new project.");
    expect(text("[data-copy-comes]"))
      .toBe("Comes with 1 map, 1 workflow and 4 datasets, 3.0 MB. Downloads 3.0 MB first. The template stays as it is.");
  });

  it("copies an installed map template under the typed name and lands in its map's builder", async () => {
    await show("harbour-stations", detail({}));
    await type("  Our harbour  ");
    await confirm();
    expect(writes()).toEqual([{ path: "/api/templates/harbour-stations/copy", body: { name: "Our harbour", version: 1 } }]);
    expect(nav.push).toHaveBeenCalledWith("/maps/map-9");
  });

  it("downloads an absent version first, then copies it, and lands a workflow example on its canvas", async () => {
    await show("busy-stations", busy(2, false));
    await confirm();
    expect(writes()).toEqual([
      { path: "/api/templates/busy-stations/fetch", body: { version: 2 } },
      { path: "/api/templates/busy-stations/copy", body: { name: "Busy stations, renewed", version: 2 } },
    ]);
    expect(nav.push).toHaveBeenCalledWith("/workflows/recipe-9");
  });

  it("from a card, reads the template once as it opens and copies that version after the index moved", async () => {
    await show("busy-stations");
    expect(text("[data-copy-sub]")).toBe("Busy stations, version 1, becomes yours in a new project.");
    expect(calls).toEqual([{ method: "GET", path: "/api/templates/busy-stations", body: null }]);
    listed = busy(2, false); // the index moves while the dialog stands
    await confirm();
    expect(writes()).toEqual([
      { path: "/api/templates/busy-stations/fetch", body: { version: 1 } },
      { path: "/api/templates/busy-stations/copy", body: { name: "Busy stations", version: 1 } },
    ]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("from a template's page, copies the page's version and reads nothing", async () => {
    listed = busy(2, false); // the index moved after the page was served
    await show("busy-stations", busy(1, true));
    await confirm();
    expect(calls).toEqual([{ method: "POST", path: "/api/templates/busy-stations/copy", body: { name: "Busy stations", version: 1 } }]);
  });

  it("says why a download was refused and copies nothing", async () => {
    refuse.fetch = { status: 409, code: "template_checksum_mismatch", message: "The archive did not match its checksum." };
    await show("busy-stations", busy(2, false));
    await confirm();
    expect(writes().map((w) => w.path)).toEqual(["/api/templates/busy-stations/fetch"]);
    expect(text("[role=\"alert\"]")).toBe("The archive did not match its checksum.");
    expect(nav.push).not.toHaveBeenCalled();
    expect(button("Make a copy").disabled).toBe(false);
  });

  it("says why a copy was refused, lands nowhere, and lets the person try again", async () => {
    refuse.copy = { status: 409, code: "template_not_installed", message: "Version 2 is not on this server yet. Nothing was created." };
    await show("busy-stations", busy(2, true));
    await confirm();
    expect(text("[role=\"alert\"]")).toBe("Version 2 is not on this server yet. Nothing was created.");
    expect(nav.push).not.toHaveBeenCalled();
    delete refuse.copy;
    await confirm();
    expect(nav.push).toHaveBeenCalledWith("/workflows/recipe-9");
  });

  it("asks for a name before sending anything", async () => {
    await show("harbour-stations", detail({}));
    await type("   ");
    await confirm();
    expect(text("[role=\"alert\"]")).toBe("Give it a name.");
    await type("x".repeat(121));
    await confirm();
    expect(text("[role=\"alert\"]")).toBe("At most 120 characters.");
    expect(writes()).toEqual([]);
  });

  it("closes on Cancel, sending nothing", async () => {
    await show("harbour-stations", detail({}));
    await act(async () => button("Cancel").click());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("says when the template cannot be read, offering no copy", async () => {
    await show("no-such-template");
    expect(text("[role=\"alert\"]")).toBe("Not found.");
    expect(button("Make a copy").disabled).toBe(true);
  });
});
