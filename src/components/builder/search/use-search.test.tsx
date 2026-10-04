import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDomHost } from "../../testing/dom-host";
import { useSearch } from "./use-search";
let search: ReturnType<typeof useSearch>;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
const pending: { signal: AbortSignal; resolve: (r: Response) => void; reject: (error: Error) => void }[] = [];
function Probe() {
  const current = useSearch("fixture", null);
  useEffect(() => { search = current; });
  return null;
}
beforeEach(async () => {
  host = installDomHost(); pending.length = 0;
  root = createRoot(host.document.body.appendChild(host.document.createElement("div")) as unknown as Element);
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise<Response>((resolve, reject) => pending.push({ signal: init.signal, resolve, reject }))));
  await act(async () => root.render(<Probe />));
  await act(async () => search.type("first"));
  await act(async () => search.submit());
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); host.uninstall(); });
it("aborts on typing and resubmission, fences stale answers and abort errors", async () => {
  await act(async () => search.type("second"));
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => search.submit());
  await act(async () => search.submit());
  expect(pending[1].signal.aborted).toBe(true);
  await act(async () => pending[1].reject(new DOMException("Aborted", "AbortError")));
  expect(search.state.places).toEqual({ state: "pending" });
  await act(async () => pending[2].resolve(Response.json({ layers: [], values: [], coordinates: [], places: { state: "ok", attribution: "Current", results: [] } })));
  await act(async () => pending[0].resolve(Response.json({ places: { state: "failed", message: "Stale" } })));
  expect(search.state.places).toEqual({ state: "ok", attribution: "Current", results: [] });
});
it("aborts the submitted request when leaving the builder", async () => {
  await act(async () => root.unmount());
  expect(pending[0].signal.aborted).toBe(true);
});
