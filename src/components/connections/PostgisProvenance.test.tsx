import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DataTable } from "@/components/api";
import { PostgisProvenanceView } from "./PostgisProvenance";

const table = {
  sourceParams: {
    connectionId: "c-deleted",
    connectionName: "Stored warehouse",
    schema: "public",
    table: "roads",
  },
} as unknown as DataTable;

describe("PostGIS provenance connection reads", () => {
  it("does not present a failed connection read as a deleted connection", () => {
    const failed = renderToStaticMarkup(
      <PostgisProvenanceView
        table={table}
        state={{ status: "failed", error: "The connection list failed." }}
      />,
    );
    const deleted = renderToStaticMarkup(
      <PostgisProvenanceView table={table} state={{ status: "ready", value: [] }} />,
    );

    expect(failed).toContain("Snapshot of public.roads");
    expect(failed).not.toContain("Stored warehouse");
    expect(deleted).toContain("Stored warehouse");
  });
});
