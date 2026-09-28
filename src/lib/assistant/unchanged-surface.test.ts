import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testClient } from "@/lib/mcp/test-client";
import { runAssistant } from "./loop";
import { PendingActionStore } from "./pending";
import { stubProvider } from "./providers/stub";
import {
  BASELINE_DIR,
  captureAnthropicRequest,
  captureIdentities,
  captureOpenAiRequest,
  capturePackagePrompt,
  definitions,
  PACKAGE_PROMPT_PATH,
  frozen,
  sha256,
} from "./testing/frozen-baselines";

/** The system prompt the loop actually hands a provider, as guard
 * captures it: the bytes the fixture is a capture of. */
async function capturedSystem(): Promise<string> {
  const provider = stubProvider([{ text: "Hello.", toolCalls: [] }]);
  for await (const event of runAssistant(provider, { message: "Hi", history: [] }, { baseUrl: "http://127.0.0.1:3391", pending: new PendingActionStore() })) void event;
  return provider.recording.exchanges[0].options.system;
}

/**
 * What this piece must not move.
 *
 * Every row compares a **fresh derivation from the product's own builders**
 * against the committed contract capture, read back whole. Intentional
 * contract changes update only the affected definitions and their digests. That direction matters: the repository's
 * existing parity and schema checks each compare two current derivations of
 * one inventory, so both sides move together and neither can see the branch
 * base. These compare across it.
 *
 * Identities, not counts: an operation renamed and another added leaves every
 * count where it was. Where the frozen side is a digest rather than a copy,
 * it is a digest per definition beside one over the whole serialization, so a
 * failure names the definition that moved.
 *
 * Each row carries an in-test control showing the comparison can reject a
 * changed current side. That is the weaker half; the seeded perturbations in
 * evidence/task15-red.txt are the ones that exercise the product path.
 */

/** One committed capture, as the manifest indexes it. */
type Capture = { file: string; sha256: string };

const BASE = {
  identities: frozen<{ operations: string[]; tools: string[]; exclusions: string[] }>("identities.json"),
  mcp: frozen<ReturnType<typeof definitions>>("mcp-tools-list.json"),
  openai: frozen<ReturnType<typeof definitions>>("openai-tool-definitions.json"),
  anthropic: frozen<ReturnType<typeof definitions>>("anthropic-tool-definitions.json"),
  manifest: frozen<{
    openaiRequest: Capture;
    openaiToolDefinitions: Capture;
    anthropicRequest: Capture;
    anthropicToolDefinitions: Capture;
    mcpListing: Capture;
    identities: Capture;
    packagePrompt: { path: string; bytes: number; sha256: string };
  }>("manifest.json"),
};

describe("the assistant surface matches the committed contract baselines", () => {
  it("the operation, tool and exclusion identities are the frozen lists, whole", () => {
    const now = captureIdentities();
    expect(now).toEqual(BASE.identities);
    // Named, so a failure reads as which one moved rather than as a diff.
    expect(now.operations).toEqual(BASE.identities.operations);
    expect(now.tools).toEqual(BASE.identities.tools);
    expect(now.exclusions).toEqual(BASE.identities.exclusions);
    // A rename that keeps every count is what this row exists to catch.
    const renamed = { ...now, operations: [...now.operations.slice(1), "GET /api/renamed"].sort() };
    expect(renamed.operations).toHaveLength(BASE.identities.operations.length);
    expect(renamed).not.toEqual(BASE.identities);
  });

  it("the listing the MCP package serves is unchanged, definition by definition", async () => {
    const client = await testClient(() => Response.json({}));
    try {
      const now = definitions((await client.listTools()).tools as { name: string }[]);
      expect(now.tools).toEqual(BASE.mcp.tools);
      expect(now.count).toBe(BASE.mcp.count);
      expect(now.overall).toBe(BASE.mcp.overall);
      const [first] = Object.keys(now.tools);
      expect(first).toBeDefined();
      expect({ ...now.tools, [first]: "moved" }).not.toEqual(BASE.mcp.tools);
    } finally {
      await client.close();
    }
  });

  it("the serialized tool definitions inside each adapter's request are unchanged", async () => {
    const openai = definitions((await captureOpenAiRequest()).tools as { name: string }[]);
    const anthropic = definitions((await captureAnthropicRequest()).tools as { name: string }[]);
    expect(openai.tools).toEqual(BASE.openai.tools);
    expect(openai.overall).toBe(BASE.openai.overall);
    expect(anthropic.tools).toEqual(BASE.anthropic.tools);
    expect(anthropic.overall).toBe(BASE.anthropic.overall);
    // Each adapter is checked against its own baseline: the two serializations
    // differ, so one standing in for the other would pass nothing.
    expect(openai.overall).not.toBe(anthropic.overall);
    expect(openai.count).toBe(anthropic.count);
  });

  it("the package's captured provider-request bytes are unchanged", async () => {
    const committed = { path: PACKAGE_PROMPT_PATH, ...capturePackagePrompt() };
    expect(committed).toEqual(BASE.manifest.packagePrompt);
    expect(committed.bytes).toBeGreaterThan(0);
    // Both halves, or the row would pass on a fixture edited to accommodate a
    // change: the committed capture is the one task 1 froze, and the bytes the
    // loop builds today are still those bytes.
    const live = await capturedSystem();
    expect(Buffer.byteLength(live, "utf8")).toBe(BASE.manifest.packagePrompt.bytes);
    expect(sha256(live)).toBe(BASE.manifest.packagePrompt.sha256);
    expect(sha256(`${live} `)).not.toBe(BASE.manifest.packagePrompt.sha256);
  });

  it("the committed captures are the reference every row above compares against", () => {
    // The frozen files themselves are the reference, and there is no commit
    // hash here on purpose: a hash of this repository's own history names
    // nothing once that history is rewritten, and it never proved more than
    // the files do. A baseline regenerated inside the run would certify a
    // change against itself, so each row above reads one of these files back
    // whole. This row holds the files and the manifest that indexes them
    // together, so a capture edited to accommodate a change cannot pass as
    // the one that was committed.
    const indexed = [
      BASE.manifest.openaiRequest,
      BASE.manifest.openaiToolDefinitions,
      BASE.manifest.anthropicRequest,
      BASE.manifest.anthropicToolDefinitions,
      BASE.manifest.mcpListing,
      BASE.manifest.identities,
    ];
    expect(indexed.map((entry) => entry.file)).toHaveLength(6);
    for (const entry of indexed) {
      const bytes = readFileSync(`${BASELINE_DIR}/${entry.file}`, "utf8");
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256(bytes)).toBe(entry.sha256);
      // The comparison can fail: one character on the file's side breaks it.
      expect(sha256(`${bytes} `)).not.toBe(entry.sha256);
    }
  });
});
