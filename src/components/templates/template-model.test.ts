import { describe, expect, it } from "vitest";
import { workflowGraph } from "../workflow-graph";
import type { TemplateList } from "@/lib/templates/card";
import { absentLine, cardTags, creditInFull, creditLine, dataDateLabel, graphSteps, READING_LINE, refreshes, screenLine, toolsLine } from "./template-model";

/**
 * The words a template card is drawn with, from facts written here: the
 * data's date at each of its three grains, the credit line and its hint,
 * the tags a card has room for, a workflow example's graph and tools, and
 * when the page asks for the catalogue again.
 */

describe("a template card's words", () => {
  it("says the data's date at the grain it was given", () => {
    expect(dataDateLabel("2021")).toBe("2021");
    expect(dataDateLabel("2026-10")).toBe("Oct 2026");
    expect(dataDateLabel("2026-01-03")).toBe("3 Jan 2026");
    expect(dataDateLabel("2026-12-31")).toBe("31 Dec 2026");
    expect(dataDateLabel("2023 to 2026")).toBe("2023 to 2026");
    expect(dataDateLabel("2026-13")).toBe("2026-13");
  });

  it("credits each source by its own words, the licences in the hint", () => {
    const sources = [
      { name: "Earthquakes", licence: "CC0-1.0", credit: "U.S. Geological Survey" },
      { name: "Plates", licence: "ODC-By-1.0", credit: "Peter Bird" },
    ];
    expect(creditLine(sources)).toBe("U.S. Geological Survey · Peter Bird");
    expect(creditInFull(sources)).toBe("U.S. Geological Survey (CC0-1.0) · Peter Bird (ODC-By-1.0)");
  });

  it("shows two tags at most, in the template's order", () => {
    expect(cardTags(["Time", "3D", "Widgets"])).toEqual(["Time", "3D"]);
    expect(cardTags(["Flows"])).toEqual(["Flows"]);
  });

  it("says what an absent version downloads, and nothing for one present", () => {
    expect(absentLine({ present: false, size: 24 * 1024 * 1024 })).toBe("Downloads 24 MB when opened");
    expect(absentLine({ present: true, size: 24 * 1024 * 1024 })).toBeNull();
  });
});

describe("a workflow example's picture and tools", () => {
  const steps = [
    { id: "a", operation: "buffer", output: "stop_areas", reads: ["stops"] },
    { id: "b", operation: "spatial_join", output: "people_near", reads: ["census", "stop_areas"] },
    { id: "c", operation: "buffer", output: "wide_areas", reads: ["people_near"] },
  ];

  it("draws each step as a node by dependency and each template dataset it reads as a source", () => {
    const graph = workflowGraph(graphSteps(steps));
    const nodes = graph.nodes.filter((node) => node.kind === "node");
    const sources = graph.nodes.filter((node) => node.kind === "source");
    expect(nodes.map((node) => [node.id, node.col])).toEqual([["a", 1], ["b", 2], ["c", 3]]);
    expect(sources.map((node) => node.name)).toEqual(["stops", "census"]);
    expect(graph.edges).toEqual([
      { from: "src:stops", to: "a" },
      { from: "src:census", to: "b" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    // Nothing was run and nothing is pending: every node is a plain node.
    expect(nodes.every((node) => node.condition === "current")).toBe(true);
  });

  it("names each tool once, in the order the steps first run it", () => {
    const label = (id: string) => ({ buffer: "Buffer", spatial_join: "Spatial join" })[id] ?? id;
    expect(toolsLine(steps, label)).toBe("Buffer · Spatial join");
    expect(toolsLine([{ id: "x", operation: "unknown_tool", output: "x_out", reads: ["t"] }], label)).toBe("unknown_tool");
  });
});

describe("when the page reads the catalogue again", () => {
  const state = (over: object) => ({ state: "listed", host: null, folder: false, readAt: null, reason: null, status: null, ...over }) as Parameters<typeof refreshes>[0];
  it("asks unless the catalogue is off or its saved address cannot be read", () => {
    expect(refreshes(state({ state: "not_read" }))).toBe(true);
    expect(refreshes(state({ state: "unreachable" }))).toBe(true);
    expect(refreshes(state({ state: "refused", reason: "status", status: 404 }))).toBe(true);
    expect(refreshes(state({ state: "off" }))).toBe(false);
    expect(refreshes(state({ state: "refused", reason: "service_address_unreadable" }))).toBe(false);
  });
});

describe("the page's line about the catalogue", () => {
  const list = (over: object) => ({ templates: [], downloads: { versions: 0, bytes: 0 },
    catalogue: { state: "listed", host: "https://templates.example", folder: false, readAt: null, reason: null, status: null, ...over } }) as TemplateList;
  it("says nothing before the list answered, the server's words for a refused refresh, then the state's", () => {
    expect(screenLine(null, null, true)).toBeNull();
    expect(screenLine(list({ state: "not_read" }), null, true)).toBe(READING_LINE);
    expect(screenLine(list({ state: "not_read" }), null, false)).toBeNull();
    expect(screenLine(list({ state: "listed" }), null, true)).toBeNull();
    expect(screenLine(list({ state: "off" }), null, false)).toBe("The template catalogue is turned off, so only the templates on this server show.");
    expect(screenLine(list({ state: "refused", reason: "status", status: 503 }), null, false))
      .toBe("The template catalogue answered with status 503, so only the templates on this server show.");
    expect(screenLine(list({ state: "listed" }), "The template catalogue is turned off on this instance.", true)).toBe("The template catalogue is turned off on this instance.");
    // The catalogue's host is never in the line.
    for (const state of ["listed", "empty", "unreachable", "slow", "off"]) expect(screenLine(list({ state }), null, false) ?? "").not.toContain("templates.example");
  });
});
