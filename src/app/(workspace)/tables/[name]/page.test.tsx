import { describe, expect, it, vi } from "vitest";
import TablePage from "./page";

vi.mock("@/components/TableDetailScreen", () => ({ TableDetailScreen: () => null }));

describe("the dataset page's open-with-panel address", () => {
  it("opens the panel for ?geometry=set and for nothing else", async () => {
    const at = async (query: Record<string, string | string[]>) =>
      (await TablePage({ params: Promise.resolve({ name: "trips" }), searchParams: Promise.resolve(query) })).props as { name: string; openGeometry: boolean };
    expect(await at({ geometry: "set" })).toEqual({ name: "trips", openGeometry: true });
    expect(await at({})).toEqual({ name: "trips", openGeometry: false });
    expect(await at({ geometry: "clear" })).toEqual({ name: "trips", openGeometry: false });
    expect(await at({ geometry: ["set"] })).toEqual({ name: "trips", openGeometry: false });
  });
});
