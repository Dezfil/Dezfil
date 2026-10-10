import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { CustomBasemapSection } from "./CustomBasemapSection";

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
const pending: { signal?: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
const onSave = vi.fn(async () => true);
function inputProps() {
  const input = container.querySelector('input[type="url"]')!;
  const key = Object.keys(input).find(key => key.startsWith("__reactProps$"))!;
  return (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void; onKeyDown: (e: { key: string }) => void }>)[key];
}
async function click(label: string) {
  const button = container.querySelectorAll("button").find(b => b.textContent.endsWith(label))!;
  expect(button, label).toBeTruthy();
  await act(async () => button.click());
}
async function edit(value = "https://fixture.test/style") { await act(async () => inputProps().onChange({ target: { value } })); }
const valid = (name: string) => Response.json({ verdict: "valid", name, layerCount: 1, sourceCount: 0, attribution: [] });
beforeEach(async () => {
  host = installDomHost(); container = host.document.body.appendChild(host.document.createElement("div"));
  root = createRoot(container as unknown as Element); pending.length = 0; onSave.mockClear();
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise<Response>((resolve, reject) => pending.push({ signal: init.signal, resolve, reject }))));
  await act(async () => root.render(<CustomBasemapSection custom={null} onSave={onSave} onRemove={() => {}} />));
  await click("Custom…"); await edit(); await click("Check");
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); host.uninstall(); });

it.each(["replacement", "edit", "Cancel", "unmount"])("aborts the advisory check on %s", async reason => {
  expect(pending[0].signal?.aborted).toBe(false);
  if (reason === "replacement") await act(async () => inputProps().onKeyDown({ key: "Enter" }));
  else if (reason === "edit") await edit("https://fixture.test/new");
  else if (reason === "Cancel") await click("Cancel");
  else await act(async () => root.unmount());
  expect(pending[0].signal?.aborted).toBe(true);
});

it("ignores late answers and abort errors without clearing a replacement's pending state", async () => {
  await act(async () => inputProps().onKeyDown({ key: "Enter" }));
  await act(async () => pending[0].reject(new DOMException("Aborted", "AbortError")));
  expect(container.textContent).toContain("Checking…");
  expect(container.textContent).not.toContain("request itself failed");
  await act(async () => pending[1].resolve(valid("Current")));
  expect(container.textContent).toContain("Current");
  await click("Check"); await edit("https://fixture.test/edited");
  await act(async () => pending[2].resolve(valid("Stale")));
  expect(container.textContent).not.toContain("Stale");
  expect(container.textContent).not.toContain("Use this style");
});

it("still saves a completed valid check and forces a warning only when asked", async () => {
  await act(async () => pending[0].resolve(valid("Current")));
  await click("Use this style");
  // The copy the map holds (a style with no credit of its own is credited
  // to its host), and what the server is sent.
  const copy = { url: "https://fixture.test/style", name: null, attribution: [{ label: "fixture.test" }] };
  expect(onSave).toHaveBeenLastCalledWith(copy, { url: "https://fixture.test/style", name: null });
  await click("Custom…"); await edit(); await click("Check");
  await act(async () => pending[1].resolve(Response.json({ verdict: "unreachable", detail: "HTTP 503." })));
  await click("Use anyway");
  expect(onSave).toHaveBeenLastCalledWith(copy, { url: "https://fixture.test/style", name: null, force: true });
});
