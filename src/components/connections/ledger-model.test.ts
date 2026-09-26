import { describe, it, expect } from "vitest";
import {
  CONNECTION_SORTS,
  filterConnections,
  sortConnections,
} from "./ledger-model";

/** The Connections ledger's search and sort: the
 * search narrows by name, case-insensitively, on a trimmed query; the
 * sort is the reference's Recently checked order (latest check first,
 * never-checked last, ties in the ledger's own order) and Name A–Z. */

const entry = (name: string, lastCheckedAt: string | null) => ({
  connection: { name, lastCheckedAt },
  snapshots: [],
});

const names = (list: { connection: { name: string } }[]) =>
  list.map((e) => e.connection.name);

describe("filterConnections", () => {
  const ledger = [entry("Alder", null), entry("Birch", null), entry("Cedar", null)];

  it("returns the list untouched for an empty or blank query", () => {
    expect(filterConnections(ledger, "")).toBe(ledger);
    expect(filterConnections(ledger, "   ")).toBe(ledger);
  });

  it("narrows by name, case-insensitively, on the trimmed query", () => {
    expect(names(filterConnections(ledger, " bIr "))).toEqual(["Birch"]);
    expect(names(filterConnections(ledger, "er"))).toEqual(["Alder"]);
    expect(names(filterConnections(ledger, "zzz"))).toEqual([]);
  });
});

describe("sortConnections", () => {
  const ledger = [
    entry("Alder", "2026-08-30T08:00:00.000Z"),
    entry("Birch", null),
    entry("Cedar", "2026-08-31T08:00:00.000Z"),
    entry("Dogwood", null),
    entry("Elm", "2026-08-31T08:00:00.000Z"),
  ];

  it("names the two orders", () => {
    expect(CONNECTION_SORTS).toEqual(["checked", "name"]);
  });

  it("Recently checked: the latest check first, never-checked last, ties in the ledger's order", () => {
    expect(names(sortConnections(ledger, "checked"))).toEqual([
      "Cedar",
      "Elm",
      "Alder",
      "Birch",
      "Dogwood",
    ]);
  });

  it("Name A–Z", () => {
    const shuffled = [ledger[4], ledger[2], ledger[0], ledger[3], ledger[1]];
    expect(names(sortConnections(shuffled, "name"))).toEqual([
      "Alder",
      "Birch",
      "Cedar",
      "Dogwood",
      "Elm",
    ]);
  });

  it("does not reorder its input", () => {
    const before = names(ledger);
    sortConnections(ledger, "name");
    expect(names(ledger)).toEqual(before);
  });
});
