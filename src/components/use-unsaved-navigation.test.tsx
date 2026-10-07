import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { useUnsavedNavigation } from "./use-unsaved-navigation";
import { traversalTaken } from "./auth/kept-traversals";
import { ACCOUNT_CHANGED_EVENT } from "./auth/private-state";

/**
 * Unsaved work the server refused leaves Back and Forward to the browser's
 * own question: the page takes the step itself, so the private workspace
 * stands aside rather than ending the document before the person answers.
 */

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
const reload = vi.fn();

function Page({ unsaved }: { unsaved: boolean }) {
  useUnsavedNavigation(unsaved);
  return null;
}

beforeEach(() => {
  reload.mockClear();
  host = installDomHost();
  const location = { href: "https://dezfil.example/maps/m1", reload, assign: vi.fn() };
  Object.assign(host.window, { location });
  vi.stubGlobal("location", location);
  const container: HostElement = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

it("takes Back and Forward only while work is unsaved, and lets go once the account retires or the page goes", async () => {
  await act(async () => root.render(<Page unsaved={false} />));
  expect(traversalTaken()).toBe(false);
  await act(async () => root.render(<Page unsaved />));
  expect(traversalTaken()).toBe(true);
  // The page still stops the step and reloads, so the browser asks.
  const step = { type: "popstate", stopImmediatePropagation: vi.fn() };
  host.window.dispatchEvent(step);
  expect(step.stopImmediatePropagation).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
  await act(async () => root.render(<Page unsaved={false} />));
  expect(traversalTaken()).toBe(false);
  await act(async () => root.render(<Page unsaved />));
  expect(traversalTaken()).toBe(true);
  host.window.dispatchEvent({ type: ACCOUNT_CHANGED_EVENT });
  expect(traversalTaken()).toBe(false);
  await act(async () => root.render(null));
  expect(traversalTaken()).toBe(false);
});
