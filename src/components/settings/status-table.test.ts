import { describe, expect, it } from "vitest";
import { PARTS, PART_FAILURES, type Part, type PartFailure, type PartTestAnswer } from "@/lib/system/part-test-answer";
import type { PartStates } from "@/lib/system/part-states";
import { instanceReadFixture } from "./read-fixture";
import { partMeta, partState, STATUS_ROWS, type Health } from "./status-table";

/**
 * Status's part rows in words: what each row shows of its part under its
 * label, and its state from the reads, then from a Test's answer where the
 * answer decides it. The engine's state is Ready with its extensions or
 * Not started yet; the tile builder's and the renderer's Found or Not
 * found; the data folder's Writable or Not writable; the metadata
 * database's Ready.
 */

const FRESH: PartStates = instanceReadFixture().parts;
const read = (parts: Partial<PartStates> = {}, dataDir = "/data") =>
  instanceReadFixture({ dataDir: { value: dataDir, source: "environment", locked: true } }, { parts: { ...FRESH, ...parts } });
const passed = (part: Part): PartTestAnswer => ({ part, result: "passed", milliseconds: 12 });
const failed = (part: Part, reason: PartFailure): PartTestAnswer => ({ part, result: "failed", reason });
const words = (part: Part, parts: PartStates, health: Health, answer: PartTestAnswer | null) => partState(part, parts, health, answer).text;

describe("the Status rows' words", () => {
  it("lists the five parts with a Test, in Status's order, each at its own address", () => {
    expect(PARTS.map(part => [STATUS_ROWS[part].id, STATUS_ROWS[part].label])).toEqual([
      ["sys-data-folder", "Data folder"], ["sys-engine", "Query engine"], ["sys-tiler", "Tile builder"],
      ["sys-renderer", "Image renderer"], ["sys-metadata", "Metadata database"],
    ]);
  });

  it("shows under each label what is known of the part: a path and a file name in the code face", () => {
    expect(partMeta("data_folder", read())).toEqual({ text: "/data", mono: true });
    expect(partMeta("query_engine", read())).toEqual({ text: "DuckDB 1.5.4" });
    expect(partMeta("query_engine", read({ query_engine: { version: "1.5.4", started: true, extensions: ["spatial", "h3", "json"] } })))
      .toEqual({ text: "DuckDB 1.5.4 · spatial, h3, json" });
    expect(partMeta("query_engine", read({ query_engine: { version: null, started: false, extensions: [] } }))).toEqual({ text: "DuckDB" });
    expect(partMeta("tile_builder", read())).toEqual({ text: "tippecanoe" });
    expect(partMeta("tile_builder", read({ tile_builder: { found: true, version: "2.79.0" } }))).toEqual({ text: "tippecanoe 2.79.0" });
    expect(partMeta("image_renderer", read({ image_renderer: { found: true, available: true, imagesAtOnce: 3 } }))).toEqual({ text: "Chromium · 3 at once" });
    expect(partMeta("metadata_database", read())).toEqual({ text: "metadata.sqlite", mono: true });
  });

  it("reads each part's state from the reads before any Test", () => {
    expect(partState("data_folder", FRESH, "checking", null)).toEqual({ tone: "checking", text: "Checking" });
    expect(partState("data_folder", FRESH, "ready", null)).toEqual({ tone: "on", text: "Writable" });
    expect(partState("data_folder", FRESH, "unready", null)).toEqual({ tone: "danger", text: "Not writable" });
    expect(partState("query_engine", FRESH, "ready", null)).toEqual({ tone: "off", text: "Not started yet" });
    expect(partState("query_engine", { ...FRESH, query_engine: { version: "1.5.4", started: true, extensions: ["spatial"] } }, "ready", null))
      .toEqual({ tone: "on", text: "Ready" });
    for (const part of ["tile_builder", "image_renderer"] as const) {
      expect(partState(part, FRESH, "ready", null)).toEqual({ tone: "on", text: "Found" });
      expect(partState(part, { ...FRESH, tile_builder: { found: false, version: null }, image_renderer: { found: false, available: false, imagesAtOnce: 2 } }, "ready", null))
        .toEqual({ tone: "danger", text: "Not found" });
    }
    expect(partState("metadata_database", FRESH, "ready", null)).toEqual({ tone: "on", text: "Ready" });
  });

  it("follows a Test's answer where it decides the state, and the reads where it does not", () => {
    const missing: PartStates = { ...FRESH, tile_builder: { found: false, version: null }, image_renderer: { found: false, available: false, imagesAtOnce: 2 } };
    // A pass is the part working.
    expect(words("data_folder", FRESH, "unready", passed("data_folder"))).toBe("Writable");
    expect(words("query_engine", FRESH, "ready", passed("query_engine"))).toBe("Ready");
    expect(words("tile_builder", missing, "ready", passed("tile_builder"))).toBe("Found");
    expect(words("image_renderer", missing, "ready", passed("image_renderer"))).toBe("Found");
    expect(words("metadata_database", FRESH, "ready", passed("metadata_database"))).toBe("Ready");
    // Not found: the program is not where its setting points; the engine is left unstarted.
    expect(words("tile_builder", FRESH, "ready", failed("tile_builder", "not_found"))).toBe("Not found");
    expect(words("image_renderer", FRESH, "ready", failed("image_renderer", "not_found"))).toBe("Not found");
    expect(words("query_engine", { ...FRESH, query_engine: { version: "1.5.4", started: true, extensions: ["spatial"] } }, "ready",
      failed("query_engine", "not_found"))).toBe("Not started yet");
    // The data folder failing to take a file is not writable, whatever the readiness check said.
    for (const reason of ["failed", "timed_out"] as const) expect(words("data_folder", FRESH, "ready", failed("data_folder", reason))).toBe("Not writable");
    // Busy, past its limit or failed leave a program found and the database ready.
    for (const reason of PART_FAILURES.filter(reason => reason !== "not_found")) {
      expect(words("tile_builder", FRESH, "ready", failed("tile_builder", reason))).toBe("Found");
      expect(words("image_renderer", missing, "ready", failed("image_renderer", reason))).toBe("Not found");
      expect(words("query_engine", FRESH, "ready", failed("query_engine", reason))).toBe("Not started yet");
      expect(words("metadata_database", FRESH, "ready", failed("metadata_database", reason))).toBe("Ready");
    }
  });
});
