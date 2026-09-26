// The badge a person comes back to. A connection stored Failing is opened with Retry, a relation is
// imported — which does record health — and Import another returns to the catalogue. The identity
// line above it must show what the import recorded, not the health captured when the completion was
// built. Mounted through react-dom's client into the stored-tree host in../testing, in the suite's
// node environment: no browser, no DOM library.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgConnection } from "@/lib/metadata/connections";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { PostgisPane } from "./PostgisPane";

const failureSentence = "Authentication failed. Check the username and password.";
const base: PgConnection = {
  id: "c1",
  name: "Berlin",
  host: "db.example.org",
  port: 5432,
  database: "gis",
  username: "reader",
  ssl: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  status: "failing",
  lastCheckedAt: "2026-09-19T08:00:00.000Z",
  lastCheckError: failureSentence,
  serverVersion: null,
  postgisVersion: null,
};
const recorded: PgConnection = {
  ...base,
  status: "connected",
  lastCheckedAt: "2026-09-20T08:00:00.000Z",
  lastCheckError: null,
  serverVersion: "PostgreSQL 16.4",
  postgisVersion: "3.4.3",
};
const relations = [{
  schema: "public",
  table: "roads",
  kind: "table" as const,
  system: false,
  geometryColumn: "geom",
  geometryType: "LINESTRING",
  srid: 4326,
  spatialKind: "geometry" as const,
  approxRows: 12,
}];

describe("Import another returns to the health the import recorded", () => {
  let host: ReturnType<typeof installDomHost>;
  let container: HostElement;
  let root: ReturnType<typeof createRoot>;
  let imported: boolean;

  const press = async (label: string) => {
    const button = container.querySelectorAll("button").find((b) => b.textContent?.includes(label));
    expect(button, `no button reading ${label}`).toBeDefined();
    await act(async () => { button!.click(); await new Promise((r) => setTimeout(r, 320)); });
  };

  beforeEach(() => {
    host = installDomHost();
    Object.assign(host.window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    // next/link's intersection effect reads `self` for an idle callback,
    // falling back to its timers.
    vi.stubGlobal("self", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    imported = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      // The list is the only place the recorded health can come from:
      // it answers with what the import wrote once the import has run.
      if (url === "/api/connections/postgis") {
        return { ok: true, json: async () => [imported ? recorded : base] } as unknown as Response;
      }
      if (url.endsWith("/tables")) {
        return { ok: true, json: async () => ({ tables: relations }) } as unknown as Response;
      }
      if (url.endsWith("/preview")) {
        return { ok: true, json: async () => ({ columns: [{ name: "id", type: "int4", spatialKind: null }], rows: [] }) } as unknown as Response;
      }
      if (url === "/api/imports/postgis") {
        imported = true;
        return { ok: true, json: async () => ({ id: "t1", name: "roads" }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    container = host.document.body.appendChild(host.document.createElement("div"));
    root = createRoot(container as unknown as Element);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.document.body.removeChild(container);
    vi.unstubAllGlobals();
    host.uninstall();
  });

  it("shows the recorded health, not the health captured at import time", async () => {
    await act(async () => {
      root.render(<PostgisPane initialConnectionId="c1" onTableCreated={() => {}} />);
      await new Promise((r) => setTimeout(r, 20));
    });
    // The stored failure stops the browse before the source is touched.
    expect(container.textContent).toContain(failureSentence);
    await press("Retry");
    expect(container.textContent).toContain("roads");
    await press("roads");
    await press("Import");
    // The import landed and reported the use; the done card is showing.
    expect(container.textContent).toContain("Import another");
    await press("Import another");
    expect(container.textContent, "the browse head answers for the import").toContain("PostGIS 3.4.3");
    expect(container.textContent, "not for the health captured before it").not.toContain(failureSentence);
  });
});
