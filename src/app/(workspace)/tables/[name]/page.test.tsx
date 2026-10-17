import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import type { AccountScope } from "@/lib/auth/scope";
import TablePage from "./page";

vi.mock("@/components/TableDetailScreen", () => ({ TableDetailScreen: () => null }));
const page = vi.hoisted(() => ({ scope: null as unknown }));
vi.mock("@/lib/auth/scope-page", () => ({ requirePageScope: async () => page.scope }));

/** Ada owns the dataset "trips"; Bo belongs to nothing. */
let db: Database;
let ada: AccountScope, bo: AccountScope;
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  [ada, bo] = ["ada", "bo"].map((id) => testAccountScope(db, id));
  db.exec(`INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id)
    VALUES ('T', 'trips', 'geoparquet', 'tables/t.parquet', 1, '2026-01-01T00:00:00.000Z', 'ada');`);
  page.scope = ada;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const open = async (name: string, query: Record<string, string | string[]> = {}) =>
  (await TablePage({ params: Promise.resolve({ name }), searchParams: Promise.resolve(query) })).props as { name: string; openGeometry: boolean };

describe("the dataset page's open-with-panel address", () => {
  it("opens the panel for ?geometry=set and for nothing else", async () => {
    expect(await open("trips", { geometry: "set" })).toEqual({ name: "trips", openGeometry: true });
    expect(await open("trips")).toEqual({ name: "trips", openGeometry: false });
    expect(await open("trips", { geometry: "clear" })).toEqual({ name: "trips", openGeometry: false });
    expect(await open("trips", { geometry: ["set"] })).toEqual({ name: "trips", openGeometry: false });
  });
});

describe("the dataset page's address", () => {
  it("opens a dataset the reader reaches by its name or its identifier", async () => {
    expect((await open("T")).name).toBe("T");
    expect((await open("trips")).name).toBe("trips");
  });

  it("is not found for a dataset the reader does not reach, exactly as a missing one", async () => {
    page.scope = bo;
    await expect(open("T")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    page.scope = ada;
    await expect(open("no_such_dataset")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
