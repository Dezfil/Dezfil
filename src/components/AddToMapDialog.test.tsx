import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installDomHost } from "./testing/dom-host";
import { AddToMapDialog } from "./AddToMapDialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./MapStrip", () => ({ MapStrip: () => null }));

it("lands SQL with the selected map's displayed basis and never refreshes a refused payload", async () => {
  const host = installDomHost();
  const root = createRoot(host.document.body as unknown as Element);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (url === "/api/maps") return Response.json([{ id: "m", name: "Shown map", editRevision: "shown", layerCount: 0 }]);
    return Response.json({ error: { message: "This item has changed. Reload it before trying again." } }, { status: 409 });
  });
  try {
    await act(async () => root.render(<AddToMapDialog subject={{ sql: "SELECT 1", name: "Result", label: "Result" }} onClose={() => {}} />));
    const button = host.document.querySelectorAll("button").find((el) => el.textContent.includes("Shown map"));
    await act(async () => button!.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe("/api/maps/m/layers");
    expect(new Headers(init?.headers).get("X-Edit-Revision")).toBe("shown");
    expect(JSON.parse(String(init?.body)).sql).toBe("SELECT 1");
    expect(host.document.body.textContent).toContain("This item has changed.");
  } finally {
    act(() => root.unmount());
    fetcher.mockRestore();
    host.uninstall();
  }
});
