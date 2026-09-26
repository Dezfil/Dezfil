import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { GROUNDING_READS, MEASURED_OFFER_MODE, defaultOffer, defaultOfferMode, omittedFromOffer } from "./offer";
import { admittedTools, policyFor } from "./policy";

/** The offer derivation: inside admission on every page, holding the page's operations
 * and the grounding reads, the full admitted set with no context. */
const tools = buildTools();
const names = (set: { name: string }[]) => set.map((t) => t.name).sort();

describe("the default offer", () => {
  it("is always inside what the page's policy admits, and holds the page's operations and the grounding reads", () => {
    for (const page of ["builder", "sql", "workflow"] as const) {
      const policy = policyFor({ page } as never);
      const admitted = new Set(names(admittedTools(policy, tools)));
      const offer = names(defaultOffer(page, policy, tools, "subset"));
      for (const name of offer) expect(admitted.has(name), `${name} offered on ${page} outside admission`).toBe(true);
      expect(offer.length).toBeLessThan(admitted.size);
      for (const tool of tools) if (tool.relevance.includes(page) && admitted.has(tool.name)) expect(offer).toContain(tool.name);
      for (const read of GROUNDING_READS) if (admitted.has(read)) expect(offer, `${read} on ${page}`).toContain(read);
      // Discovery's reach is the complement inside admission, never beyond it.
      const omitted = names(omittedFromOffer(page, policy, tools, "subset"));
      expect([...offer, ...omitted].sort()).toEqual([...admitted].sort());
    }
  });
  it("keeps the full admitted set with no page context, and in the full mode", () => {
    expect(names(defaultOffer(undefined, "full", tools, "subset"))).toEqual(names(tools));
    expect(names(defaultOffer("builder", "full", tools, "full"))).toEqual(names(tools));
    expect(names(defaultOffer("sql", "read_only", tools, "full"))).toEqual(names(admittedTools("read_only", tools)));
    expect(omittedFromOffer(undefined, "full", tools, "subset")).toEqual([]);
  });
  it("narrows each page to its own work: the sizes the measurement compares", () => {
    // 40: the map check (look_at_map) is builder work; its image read is offered on no page.
    expect(defaultOffer("builder", "full", tools, "subset")).toHaveLength(40);
    expect(defaultOffer("sql", "read_only", tools, "subset")).toHaveLength(12);
    expect(defaultOffer("workflow", "read_only", tools, "subset")).toHaveLength(18);
    // A write is never offered where it is not admitted, whatever its relevance.
    expect(names(defaultOffer("workflow", "read_only", tools, "subset"))).not.toContain("run_recipe");
    expect(names(defaultOffer("sql", "read_only", tools, "subset"))).not.toContain("update_map");
  });
});

describe("the mode the instance runs", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is the measured default, the page's subset (the live arm of 2026-09-19), unless DEZFIL_ASSISTANT_OFFER names a mode", () => {
    expect(MEASURED_OFFER_MODE).toBe("subset");
    expect(defaultOfferMode({})).toBe("subset");
    expect(defaultOfferMode({ DEZFIL_ASSISTANT_OFFER: "subset" })).toBe("subset");
    expect(defaultOfferMode({ DEZFIL_ASSISTANT_OFFER: "full" })).toBe("full");
    expect(defaultOfferMode({ DEZFIL_ASSISTANT_OFFER: "narrow" })).toBe("subset");
    // The derivation's default argument reads the same setting.
    vi.stubEnv("DEZFIL_ASSISTANT_OFFER", "");
    expect(defaultOffer("sql", "read_only", tools)).toHaveLength(12);
    vi.stubEnv("DEZFIL_ASSISTANT_OFFER", "full");
    expect(names(defaultOffer("sql", "read_only", tools))).toEqual(names(admittedTools("read_only", tools)));
  });
});
