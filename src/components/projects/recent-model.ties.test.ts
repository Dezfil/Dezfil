import { expect, it } from "vitest";
import { recentItems } from "./recent-model";
import type { MapOverview, TableListing } from "../api";
import type { WorkflowListing } from "../workflow-model";

/**
 * The empty project home's recent order where times are equal, as the home
 * asks for it: the kinds in the order maps, workflows, datasets, and within
 * a kind the order its list answered in, so the same items listed the other
 * way round come back the other way round.
 */

const T = "2026-09-05T00:00:00Z";
const map = (id: string) =>
  ({ id, name: id, projectId: null, layerCount: 1, updatedAt: T, lastChangedAt: T }) as unknown as MapOverview;
const wf = (id: string) =>
  ({
    id, name: id, origin: "workflow", projectId: null, updatedAt: T, lastChangedAt: T,
    summary: { nodes: 1, sources: 0, liveOutputs: 0, status: "up_to_date", count: 0 }, steps: [],
  }) as unknown as WorkflowListing;
const table = (id: string) =>
  ({ id, name: id, projectIds: [], rowCount: 1, geometryColumn: null, geometryType: null, importedAt: T, createdAt: T }) as unknown as TableListing;
const none = { maps: new Set<string>(), workflows: new Set<string>(), tables: new Set<string>() };
const ask = (maps: string[], workflows: string[], tables: string[], limit?: number) =>
  recentItems({
    maps: maps.map(map), workflows: workflows.map(wf), tables: tables.map(table),
    projectId: "home", exclude: none, names: new Map(), limit,
  }).map((item) => item.id);

it("keeps equal times in the lists' order, maps before workflows before datasets", () => {
  expect(ask(["m-b", "m-a"], ["w-b", "w-a"], ["t-b", "t-a"], 10)).toEqual(["m-b", "m-a", "w-b", "w-a", "t-b", "t-a"]);
});

it("returns the same items listed the other way round the other way round", () => {
  expect(ask(["m-a", "m-b"], ["w-a", "w-b"], ["t-a", "t-b"], 10)).toEqual(["m-a", "m-b", "w-a", "w-b", "t-a", "t-b"]);
});

it("cuts six equal times by that order", () => {
  expect(ask(["m-c", "m-a", "m-b"], ["w-b", "w-a"], ["t-b", "t-a"])).toEqual(["m-c", "m-a", "m-b", "w-b", "w-a", "t-b"]);
});
