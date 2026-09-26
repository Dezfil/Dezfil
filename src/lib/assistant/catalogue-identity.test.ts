import shipped from "./model-catalogue.json";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeModel } from "./model-knowledge";

// Captured independently from 12bd302e's table before the move. Neither
// identities nor names, labels or level order come from the new JSON file.
const rows = [
  ["openai", "gpt-6-astra", "Astra", ["low", "medium", "high", "xhigh"]],
  ["openai", "gpt-5.6-sol", "Sol", ["low", "medium", "high", "xhigh"]],
  ["openai", "gpt-5.6-terra", "Terra", ["minimal", "low", "medium", "high"]],
  ["openai", "gpt-5.6-nova", "Nova", ["minimal", "low", "medium", "high"]],
  ["anthropic", "claude-opus-5", "Opus 5", ["low", "medium", "high", "xhigh", "max"]],
  ["anthropic", "claude-fable-5", "Fable 5", ["low", "medium", "high", "xhigh"]],
  ["anthropic", "claude-sonnet-5", "Sonnet 5", ["low", "medium", "high"]],
  ["anthropic", "claude-haiku-4", "Haiku 4", ["low", "medium", "high"]],
] as const;
const labels: Record<string, string> = { default: "Default", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

describe("independent eight-model capture", () => {
  it("reads the file with exactly the original identities, names, levels and ordering", () => {
    const file = JSON.parse(readFileSync(path.join(process.cwd(), "src/lib/assistant/model-catalogue.json"), "utf8"));
    expect(Object.keys(file)).toEqual(["openai", "anthropic"]);
    for (const provider of ["openai", "anthropic"]) {
      expect(file[provider]).toEqual(rows.filter(([p]) => p === provider).map(([, id, name, efforts]) => ({ id, name, efforts })));
    }
  });
  it.each(rows)("%s %s retains its name, values, labels and default-first order", (provider, id, name, efforts) => {
    expect(describeModel(provider, id, shipped)).toEqual({ id, name, efforts: ["default", ...efforts].map((value) => ({ value, label: labels[value] })) });
  });
});
