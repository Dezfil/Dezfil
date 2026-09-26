// When the health badge may have moved (g). Browsing and previewing a relation record nothing about
// the connection, so the surface that owns the badge has nothing to re-read after them; an import
// does write the connection's health, so it still reports the use. Mounted through react-dom's
// client into the stored-tree host in../testing, in the suite's node environment: no browser, no
// DOM library.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgConnection } from "@/lib/metadata/connections";
import type { DataTable } from "@/components/api";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { PostgisRelationDetail } from "./PostgisRelationDetail";
import type { PostgisRemoteRelation } from "./postgis-pane-types";

const connection: PgConnection = {
  id: "c1",
  name: "Berlin",
  host: "db.example.org",
  port: 5432,
  database: "gis",
  username: "reader",
  ssl: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  status: "connected",
  lastCheckedAt: "2026-09-19T08:00:00.000Z",
  lastCheckError: null,
  serverVersion: "PostgreSQL 16.4",
  postgisVersion: "3.4.3",
};
const relation: PostgisRemoteRelation = {
  schema: "public",
  table: "roads",
  kind: "table",
  system: false,
  geometryColumn: "geom",
  geometryType: "LINESTRING",
  srid: 4326,
  spatialKind: "geometry",
  approxRows: 12,
};
const preview = {
  columns: [{ name: "id", type: "int4", spatialKind: null }],
  rows: [{ id: 7 }],
};
const table = { id: "t1", name: "roads" } as unknown as DataTable;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 320)); });

describe("what reports a connection's use to the badge", () => {
  let host: ReturnType<typeof installDomHost>;
  let container: HostElement;
  let root: ReturnType<typeof createRoot>;
  let used: ReturnType<typeof vi.fn<(connectionId: string) => void>>;
  let calls: string[];

  beforeEach(() => {
    host = installDomHost();
    // The debounced preview schedules on `window`; the stored tree carries
    // no timers of its own.
    Object.assign(host.window, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    calls = [];
    used = vi.fn<(connectionId: string) => void>();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/preview")) {
        return { ok: true, json: async () => preview } as unknown as Response;
      }
      if (url === "/api/imports/postgis") {
        return { ok: true, json: async () => table } as unknown as Response;
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

  it("a relation's preview reports nothing; its import reports the use", async () => {
    await act(async () => root.render(
      <PostgisRelationDetail
        connection={connection}
        relation={relation}
        onConnectionUsed={used}
        onTableCreated={() => {}}
      />,
    ));
    await settle();
    // The preview landed: this is not a case where nothing happened.
    expect(calls.filter((url) => url.endsWith("/preview"))).toHaveLength(1);
    expect(container.textContent).toContain("1 columns");
    expect(used, "a preview writes no health, so it reports no use").not.toHaveBeenCalled();

    const button = container.querySelectorAll("button").find((b) => b.textContent === "Import");
    await act(async () => { button!.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toContain("/api/imports/postgis");
    expect(used, "an import writes health, so the badge is re-read").toHaveBeenCalledWith("c1");
    expect(used).toHaveBeenCalledTimes(1);
  });
});
