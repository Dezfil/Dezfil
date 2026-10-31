import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDomHost } from "../testing/dom-host";
import { useSearchSources, type SearchSources } from "./use-search-sources";

/** A search reads the sign-in mode, for a member and an admin, so it finds no
 * password row on an instance that takes no password. */

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let seen: SearchSources;
function Probe({ admin }: { admin: boolean }) {
  const { sources } = useSearchSources(1, admin);
  useEffect(() => { seen = sources; }, [sources]);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/config" ? Response.json({ externalSignIn: { enabled: true } }) : Response.json({ tokens: [], look: {} })));
  host = installDomHost();
  root = createRoot(host.document.createElement("div") as unknown as Element);
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });

it.each([true, false])("carries the mode for admin %s", async admin => {
  await act(async () => root.render(<Probe admin={admin} />));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(seen.external).toBe(true);
});
