import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { DISCARD_MESSAGE, DocumentSequence } from "./document-sequence";
import { BuilderStaleNotice } from "./builder/BuilderStaleNotice";
import type { useBuilderMutations } from "./builder/use-builder-mutations";
import { CanvasStaleStatus } from "./workflow-canvas/CanvasStaleStatus";
import { CanvasRecoveryContext } from "./workflow-canvas/WorkflowRecovery";
import { WorkflowDocument } from "./workflow-canvas/workflow-document";

/**
 * Where a halted editor's Reload leads. After a stale revision it reads
 * the document again and seeds a fresh editor in place. After access has
 * ended (the person was made a Viewer, removed from the project, or the
 * owner deactivated) a read in place would hand a Viewer an editable
 * editor again, or fail for someone removed; so, past the same confirm
 * step, the page itself reloads and the server decides what the person
 * may now see. The browser does not ask a second time.
 */

/** Made a Viewer (or the owner deactivated), and removed from the project. */
const ENDED = [
  ["no longer theirs to change", 403, "forbidden", "You can view this but cannot make this change."],
  ["no longer reached", 404, "not_found", "The requested resource was not found."],
] as const;
const STALE = [409, "stale_revision", "This item has changed. Reload it before trying again."] as const;

const MAP = { id: "m", name: "Map", basemap: "light", basemapLayers: null, layers: [], widgets: [], editRevision: "fresh" } as unknown as MapWithLayers;

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
let asked: boolean | null;
let reads: string[];
const reload = vi.fn(() => {
  // What the browser would hear as the page goes: a guard still listening would make it ask again.
  const going = { type: "beforeunload", preventDefault: vi.fn(), returnValue: undefined as unknown };
  host.window.dispatchEvent(going);
  asked = going.preventDefault.mock.calls.length > 0;
});

beforeEach(() => {
  reload.mockClear(); asked = null; reads = [];
  host = installDomHost();
  const location = { href: "https://dezfil.example/maps/m", reload, assign: vi.fn(), replace: vi.fn() };
  Object.assign(host.window, { location });
  vi.stubGlobal("location", location);
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

/** The server refuses the write with the given answer and serves the map to a read. */
function serve(status: number, code: string, message: string) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? "GET") !== "GET") return Response.json({ error: { code, message } }, { status });
    reads.push(path);
    return Response.json(MAP);
  });
}

const buttons = (label: string) => container.querySelectorAll("button").filter(button => button.textContent === label);
/** Reload, then Reload again on the confirm step, letting any read settle. */
async function reloadTwice() {
  const first = buttons("Reload");
  expect(first).toHaveLength(1);
  await act(async () => { first[0].click(); });
  expect(container.textContent).toContain(DISCARD_MESSAGE);
  expect(buttons("Not now")).toHaveLength(1);
  const confirmed = buttons("Reload");
  expect(confirmed).toHaveLength(1);
  await act(async () => { confirmed[0].click(); await new Promise(resolve => setTimeout(resolve, 0)); });
}

/** A builder whose map save met the given refusal, showing its halted notice. */
async function haltedBuilder([status, code, message]: readonly [number, string, string]) {
  serve(status, code, message);
  const sequence = new DocumentSequence("m");
  sequence.accept({ editRevision: "seen" });
  await sequence.writeFetch("/api/maps/m", { method: "PATCH", body: "{}" });
  expect(sequence.stale).toBe(true);
  const mutations = { stale: true, savedMap: MAP, drafts: { apply: (map: MapWithLayers) => map, hasLayer: () => false }, legendLive: {}, sequence } as unknown as ReturnType<typeof useBuilderMutations>;
  const recovered = vi.fn();
  await act(async () => root.render(<BuilderStaleNotice mutations={mutations} onRecovered={recovered} />));
  return recovered;
}

/** A workflow canvas whose step edit met the given refusal, showing its halted status. */
async function haltedCanvas([status, code, message]: readonly [number, string, string]) {
  serve(status, code, message);
  const document = new WorkflowDocument("w");
  document.accept({ editRevision: "seen" });
  await document.writeFetch("/api/recipes/w/steps/n", { method: "PATCH", body: "{}" });
  expect(document.stale).toBe(true);
  const recover = vi.fn(async () => {});
  await act(async () => root.render(<CanvasRecoveryContext.Provider value={{ document, recover }}><CanvasStaleStatus /></CanvasRecoveryContext.Provider>));
  return recover;
}

describe("the builder's halted notice", () => {
  it.each(ENDED)("reloads the page once a save is refused as %s, without reading the map in place or the browser asking again", async (_name, ...refusal) => {
    const recovered = await haltedBuilder(refusal);
    await reloadTwice();
    expect(reload).toHaveBeenCalledOnce();
    expect(asked).toBe(false);
    expect(reads).toEqual([]);
    expect(recovered).not.toHaveBeenCalled();
  });

  it("reads the map again in place after a stale revision, and leaves the page where it is", async () => {
    const recovered = await haltedBuilder(STALE);
    await reloadTwice();
    expect(reload).not.toHaveBeenCalled();
    expect(reads).toEqual(["/api/maps/m"]);
    expect(recovered).toHaveBeenCalledOnce();
  });
});

describe("the workflow canvas's halted status", () => {
  it.each(ENDED)("reloads the page once an edit is refused as %s, without recovering in place or the browser asking again", async (_name, ...refusal) => {
    const recover = await haltedCanvas(refusal);
    await reloadTwice();
    expect(reload).toHaveBeenCalledOnce();
    expect(asked).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it("recovers in place after a stale revision, and leaves the page where it is", async () => {
    const recover = await haltedCanvas(STALE);
    await reloadTwice();
    expect(reload).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
  });
});
