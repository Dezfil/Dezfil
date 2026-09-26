import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PgConnection } from "@/lib/metadata/connections";
import { PostgisPicker } from "./PostgisPicker";

const connection: PgConnection = {
  id: "c1",
  name: "Berlin",
  host: "db.example.org",
  port: 5432,
  database: "gis",
  username: "reader",
  ssl: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  status: "failing",
  lastCheckedAt: "2026-08-31T08:00:00.000Z",
  lastCheckError: "Authentication failed. Check the username and password.",
  serverVersion: "PostgreSQL 16.4",
  postgisVersion: "3.4.3",
};

describe("PostGIS connection picker", () => {
  it("renders persisted identity and status without a source result", () => {
    const html = renderToStaticMarkup(
      <PostgisPicker
        connections={[connection]}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    expect(html).toContain("Berlin");
    expect(html).toContain("db.example.org:5432/gis");
    expect(html).toContain("Failing");
    expect(html).toContain('href="/connections"');
    expect(html).not.toContain(connection.lastCheckError!);
  });
});
