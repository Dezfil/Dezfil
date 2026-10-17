import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOGUE_LIMIT, readModelCatalogue, validateCatalogue } from "./model-catalogue";
import { describeModel } from "./model-knowledge";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "model-catalogue-"));
  file = path.join(dir, "assistant-models.json");
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const put = (value: unknown) => writeFileSync(file, JSON.stringify(value));
const model = (id: string, name = id, efforts: string[] = []) => ({ id, name, efforts });

describe("whole catalogue contract", () => {
  it("the runbook example is a valid both-provider instance file and new docs have no em dashes", () => {
    const section = readFileSync("docs/operate/runbook.md", "utf8").split("## The model catalogue file")[1];
    expect(section).toBeDefined();
    expect(section).not.toContain("\u2014");
    const example = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();
    const parsed = validateCatalogue(JSON.parse(example!));
    expect(parsed.openai).toHaveLength(2);
    expect(parsed.anthropic).toHaveLength(2);
    for (const row of readFileSync("README.md", "utf8").split("\n").filter((line) => /^\| `DEZFIL_(DATA_DIR|AI_MODELS_OPENAI|AI_MODELS_ANTHROPIC)`/.test(line))) {
      expect(row).toContain("docs/operate/runbook.md#the-model-catalogue-file");
      expect(row).not.toContain("\u2014");
    }
  });

  it("validates the shipped file, bounded to 256 KiB, and empty levels offer default alone", () => {
    const bytes = readFileSync("src/lib/assistant/model-catalogue.json");
    expect(bytes.length).toBeLessThanOrEqual(CATALOGUE_LIMIT);
    expect(() => validateCatalogue(JSON.parse(bytes.toString()), true)).not.toThrow();
    put({ openai: [model("empty")] });
    expect(describeModel("openai", "empty", readModelCatalogue().models).efforts).toEqual([{ value: "default", label: "Default" }]);
  });

  it.each(["openai", "anthropic", "both"])("adds and completely overrides %s, retaining positions and append order", (which) => {
    const before = readModelCatalogue().models;
    const instance = {
      ...(which !== "anthropic" ? { openai: [model("new-b"), model("gpt-5.6-sol", "Replaced", ["none"]), model("new-a")] } : {}),
      ...(which !== "openai" ? { anthropic: [model("new-b", "Other", ["max"]), model("claude-fable-5", "Replaced"), model("new-a")] } : {}),
    };
    put(instance);
    const got = readModelCatalogue();
    expect(got.catalogue).toEqual({ source: "merged", instance: "applied" });
    for (const p of ["openai", "anthropic"] as const) {
      const additions = instance[p];
      expect(got.models[p]).toEqual(additions ? [before[p][0], additions[1], ...before[p].slice(2), additions[0], additions[2]] : before[p]);
    }
  });

  it.each([{}, { openai: [] }, { anthropic: [] }, { openai: [], anthropic: [] }])("an empty or omitted list hides nothing: %j", (copy) => {
    const before = readModelCatalogue();
    expect(before.catalogue).toEqual({ source: "shipped", instance: "absent" });
    put(copy);
    expect(readModelCatalogue()).toEqual({ models: before.models, catalogue: { source: "merged", instance: "applied" } });
  });

  const invalid: [string, unknown, string][] = [
    ["null", null, "catalogue"], ["array", [], "catalogue"],
    ["unknown provider", { other: [] }, "catalogue"], ["unknown top field", { version: 1 }, "catalogue"],
    ["wrong provider list", { openai: {} }, "openai"],
    ["bad entry", { openai: [null] }, "openai[0]"],
    ["unknown entry field", { openai: [{ ...model("x"), token: "private-sentinel" }] }, "openai[0]"],
    ["duplicate identity", { openai: [model("x"), model("x")] }, "openai[1].id"],
    ["missing id", { openai: [{ name: "X", efforts: [] }] }, "openai[0].id"],
    ["blank id", { openai: [model(" \t")] }, "openai[0].id"],
    ["nonstring id", { openai: [{ ...model("x"), id: 1 }] }, "openai[0].id"],
    ["missing name", { openai: [{ id: "x", efforts: [] }] }, "openai[0].name"],
    ["blank name", { openai: [model("x", " ")] }, "openai[0].name"],
    ["missing efforts", { openai: [{ id: "x", name: "X" }] }, "openai[0].efforts"],
    ["wrong effort list", { openai: [{ ...model("x"), efforts: "low" }] }, "openai[0].efforts"],
    ["invalid effort", { openai: [model("x", "X", ["max"])] }, "openai[0].efforts[0]"],
    ["default authored", { openai: [model("x", "X", ["default"])] }, "openai[0].efforts[0]"],
    ["duplicate effort", { openai: [model("x", "X", ["low", "low"])] }, "openai[0].efforts[1]"],
    ["valid prefix then bad entry", { openai: [model("prefix"), model("bad", "Bad", ["wrong"])] }, "openai[1].efforts[0]"],
    ["bad unresolved provider", { openai: [model("prefix")], anthropic: [model("bad", "Bad", ["minimal"])] }, "anthropic[0].efforts[0]"],
  ];
  it.each(invalid)("rejects the whole file: %s", (_name, bad, reason) => {
    const shipped = readModelCatalogue().models;
    put({ openai: [model("last-good")] });
    expect(readModelCatalogue().models.openai.at(-1)?.id).toBe("last-good");
    put(bad);
    const got = readModelCatalogue();
    expect(got.models).toEqual(shipped);
    expect(got.catalogue).toMatchObject({ source: "shipped", instance: "rejected", reason: expect.stringContaining(reason) });
    expect(JSON.stringify(got.catalogue)).not.toContain("private-sentinel");
  });

  it.each(["syntax", "oversize", "directory", "permissions"])("rejects %s without leaking file contents", (kind) => {
    const shipped = readModelCatalogue().models;
    if (kind === "directory") mkdirSync(file);
    else {
      writeFileSync(file, kind === "oversize" ? " ".repeat(CATALOGUE_LIMIT + 1) : '{"private-sentinel":');
      if (kind === "permissions") chmodSync(file, 0);
    }
    const got = readModelCatalogue();
    expect(got.models).toEqual(shipped);
    expect(got.catalogue).toMatchObject({ source: "shipped", instance: "rejected", reason: expect.any(String) });
    expect(JSON.stringify(got.catalogue)).not.toContain("private-sentinel");
    if (kind === "permissions") chmodSync(file, 0o600);
  });

  it("accepts exactly 256 KiB and observes repair and removal without a last-good cache", () => {
    const before = readModelCatalogue();
    writeFileSync(file, "{}" + " ".repeat(CATALOGUE_LIMIT - 2));
    expect(readModelCatalogue().catalogue.instance).toBe("applied");
    writeFileSync(file, "{");
    expect(readModelCatalogue().catalogue.instance).toBe("rejected");
    put({ anthropic: [model("fixed", "Fixed", ["max"])] });
    expect(readModelCatalogue().models.anthropic.at(-1)?.id).toBe("fixed");
    rmSync(file);
    expect(readModelCatalogue()).toEqual(before);
  });

  it("a source file edit is visible on each read, with no second maintained table", () => {
    const source = path.join(dir, "src/lib/assistant");
    mkdirSync(source, { recursive: true });
    const original = readFileSync("src/lib/assistant/model-catalogue.json", "utf8");
    writeFileSync(path.join(source, "model-catalogue.json"), original);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(readModelCatalogue().models.openai[0].name).toBe("Astra");
    const edited = JSON.parse(original);
    edited.openai[0].name = "Local Astra";
    edited.openai[0].efforts = ["none"];
    writeFileSync(path.join(source, "model-catalogue.json"), JSON.stringify(edited));
    expect(describeModel("openai", "gpt-6-astra", readModelCatalogue().models)).toEqual({ id: "gpt-6-astra", name: "Local Astra", efforts: [{ value: "default", label: "Default" }, { value: "none", label: "None" }] });
  });
});
