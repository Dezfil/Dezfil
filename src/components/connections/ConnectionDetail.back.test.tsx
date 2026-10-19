import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PgConnection } from "@/lib/metadata/connections";
import { installDomHost, type HostElement } from "../testing/dom-host";

/**
 * A connection's page leads back to Connections by the square back arrow
 * before its logo and name, as a dataset's page leads back to Data, and
 * carries no second way back above it. Every read is a fake.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/connections/c1" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/use-upload-queue", () => ({
  useUploadQueue: () => ({ entries: [], add: vi.fn(), dismiss: () => 0, current: () => ({ settled: true }), reset: vi.fn() }),
}));
vi.mock("@/components/AddDataDialog", () => ({ AddDataDialog: () => null }));

const saved: PgConnection = {
  id: "c1", name: "City", host: "db.example.test", port: 5432, database: "gis", username: "reader", ssl: true,
  createdAt: "2026-09-01T00:00:00.000Z", status: "connected", lastCheckedAt: "2026-10-01T00:00:00.000Z",
  lastCheckError: null, serverVersion: "PostgreSQL 16.4", postgisVersion: "3.4.3",
};

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(async () => {
  host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") return Response.json({ rules: { "connections.create": "everyone" } });
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: false } });
    if (url === "/api/connections/postgis") return Response.json([saved]);
    if (url === "/api/connections/postgis/c1/snapshots") return Response.json({ snapshots: [] });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  container = host.document.body.appendChild(host.document.createElement("div"));
  root = createRoot(container as unknown as Element);
  const { ConnectionDetail } = await import("./ConnectionDetail");
  await act(async () => root.render(<ConnectionDetail id="c1" />));
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.document.body.removeChild(container);
  vi.unstubAllGlobals();
  host.uninstall();
});

it("leads back to Connections from before the logo and name, and nowhere else", () => {
  const head = container.querySelector("header")!;
  expect(head.querySelector("h1")?.textContent).toBe("City");
  const back = head.children[0];
  expect(back.tagName).toBe("A");
  expect(back.getAttribute("href")).toBe("/connections");
  expect(back.getAttribute("aria-label")).toBe("Back to Connections");
  expect(back.querySelector("svg")).not.toBeNull();
  expect(container.querySelectorAll("a").filter((a) => a.getAttribute("href") === "/connections")).toHaveLength(1);
});
