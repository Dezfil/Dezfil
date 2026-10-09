import { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as releasesRoute } from "@/app/api/imports/overture/releases/route";
import { egressBlockedError } from "@/lib/net/egress";
import { resetReleaseCache } from "@/lib/overture/releases";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { installDomHost } from "./testing/dom-host";
import { OverturePane } from "./OverturePane";

/**
 * The Overture pane's release picker over the server's release listing: a
 * mirror the egress check refuses reaches the pane as the check's own
 * sentence with no release offered, while an outage keeps the pinned
 * releases it has always offered. The pane's request for the list is
 * answered by the real route over a loopback mirror; every other request
 * the pane makes stays pending.
 */

vi.mock("next/dynamic", () => ({ default: () => function Lazy() { return null; } }));

// The mirror is a loopback fixture; a listing sent to the public bucket
// instead fails the test before it leaves this machine.
keepRequestsOnThisMachine();

const FALLBACK = ["2026-06-17.0", "2026-05-20.0"];
let mirror: { server: Server; asked: string[] } | null = null;
const cleanups: (() => void)[] = [];

async function serve(answer: (res: ServerResponse) => void) {
  const asked: string[] = [];
  const server = createServer((req, res) => { asked.push(req.url ?? ""); answer(res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  mirror = { server, asked };
  vi.stubEnv("DEZFIL_OVERTURE_S3_ENDPOINT", `127.0.0.1:${(server.address() as AddressInfo).port}`);
  return asked;
}

beforeEach(() => resetReleaseCache());

afterEach(async () => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetReleaseCache();
  if (mirror) await new Promise<void>(resolve => mirror!.server.close(() => resolve()));
  mirror = null;
});

async function mount() {
  const host = installDomHost();
  let listed = false;
  vi.stubGlobal("fetch", vi.fn((input: string) => {
    if (input !== "/api/imports/overture/releases") return new Promise(() => {});
    return releasesRoute().finally(() => { listed = true; });
  }));
  const root = createRoot(host.document.body as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  await act(async () => root.render(<OverturePane onTableCreated={() => {}} />));
  // Until the list's answer is read and drawn.
  for (let turn = 0; !listed; turn++) {
    if (turn > 500) throw new Error("The pane never asked for the release list.");
    await act(() => new Promise(resolve => setTimeout(resolve, 5)));
  }
  for (let turn = 0; turn < 5; turn++) await act(() => new Promise(resolve => setTimeout(resolve, 5)));
  const select = host.document.getElementById("ovt-release")!;
  return {
    offered: () => select.options.map(option => option.value),
    chosen: () => select.options.find(option => option.selected)?.value ?? null,
    disabled: () => select.disabled,
    alerts: () => host.document.querySelectorAll("[role=\"alert\"]").map(alert => alert.textContent),
  };
}

describe("the release picker", () => {
  it("says the egress check's sentence and offers no release when the mirror is refused", async () => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    const asked = await serve(res => { res.writeHead(200); res.end("<ListBucketResult/>"); });
    const pane = await mount();
    expect(pane.alerts()).toEqual([egressBlockedError().message]);
    expect(pane.offered()).toEqual([]);
    expect(pane.disabled()).toBe(true);
    expect(asked, "refused before contact").toEqual([]);
  });

  it("keeps the pinned releases through an outage, the newest chosen, with nothing to say", async () => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
    const asked = await serve(res => { res.writeHead(503); res.end("slow down"); });
    const pane = await mount();
    expect(asked).toHaveLength(1);
    expect(pane.alerts()).toEqual([]);
    expect(pane.offered()).toEqual(FALLBACK);
    expect(pane.chosen()).toBe(FALLBACK[0]);
    expect(pane.disabled()).toBe(false);
  });
});
