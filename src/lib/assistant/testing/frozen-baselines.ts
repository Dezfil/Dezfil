import { testAccountScope } from "@/lib/test-support/accounts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "@/lib/tools/tools";
import { PendingActionStore } from "../pending";
import { anthropicProvider } from "../providers/anthropic";
import { openaiProvider } from "../providers/openai";
import { anthropicWire, responseWire } from "./wire";
import { runAssistant } from "../loop";
import { DEFAULT_MODELS } from "../config";

/**
 * The assistant surfaces that must not move, derived from the product's
 * own builders. The frozen side is a committed capture; this module
 * produces the *current* side, so a comparison is a committed artifact
 * against a fresh derivation rather than two reads of one code path. The
 * tool parity check and the schema checks cannot serve here: each of them
 * compares two current derivations of one inventory, so both sides move
 * together.
 *
 * Test support only. Nothing in the product imports this.
 */

export const BASELINE_DIR = "test-support/assistant-baselines";

/** The fixture turn every request capture uses, fixed so the bodies are
 * comparable across captures. */
export const FIXTURE_TURN = {
  message: "Colour the parks by area, five classes.",
  history: [
    { role: "user" as const, content: "What is on this map?" },
    { role: "assistant" as const, content: "One layer, parks." },
  ],
  baseUrl: "http://127.0.0.1:3212",
} as const;

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Run one fixture turn through the real loop and return the complete body
 * the adapter handed its SDK, parsed. The reply carries text and no tool
 * call, so one request is made and no product operation is dispatched. */
async function captureRequest(
  make: (fetchImpl: typeof fetch) => ReturnType<typeof openaiProvider>,
  reply: () => Response,
): Promise<Record<string, unknown>> {
  const bodies: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    bodies.push(typeof init?.body === "string" ? init.body : await request.clone().text());
    return reply();
  }) as typeof fetch;
  const provider = make(fetchImpl);
  const events = runAssistant(
    provider,
    {
      message: FIXTURE_TURN.message,
      history: FIXTURE_TURN.history.map((t) => ({ role: t.role, text: t.content })),
    },
    { scope: testAccountScope(), baseUrl: FIXTURE_TURN.baseUrl, pending: new PendingActionStore() },
  );
  for await (const event of events) void event;
  if (bodies.length !== 1) throw new Error(`Expected one provider request, saw ${bodies.length}`);
  return JSON.parse(bodies[0]) as Record<string, unknown>;
}

/** The choice under test, if any. Omitted entirely, the capture is exactly
 * the committed baseline: the instance default and no effort at all. */
export type CaptureChoice = { model?: string; effort?: string };

export function captureOpenAiRequest(choice: CaptureChoice = {}): Promise<Record<string, unknown>> {
  const model = choice.model ?? DEFAULT_MODELS.openai;
  return captureRequest(
    (fetchImpl) => openaiProvider("fixture-never-sent", model, fetchImpl, choice.effort),
    () => responseWire([{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] }], model),
  );
}

export function captureAnthropicRequest(choice: CaptureChoice = {}): Promise<Record<string, unknown>> {
  const model = choice.model ?? DEFAULT_MODELS.anthropic;
  return captureRequest(
    (fetchImpl) => anthropicProvider("fixture-never-sent", model, fetchImpl, choice.effort),
    () => anthropicWire({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", model }),
  );
}

/** A definition array reduced to digests by identity: one over the exact
 * serialization of the whole array, and one per definition, so a later
 * comparison names which definition moved instead of only that something
 * did. The committed baselines were reduced by this same function, so both
 * sides of the comparison are reduced the same way. */
export const definitions = (tools: { name: string }[]) => ({
  count: tools.length,
  overall: sha256(JSON.stringify(tools)),
  tools: Object.fromEntries(tools.map((t) => [t.name, sha256(JSON.stringify(t))])),
});

/** Every documented operation, the tool each carries, and the deliberate
 * exclusions: identities, never counts. */
export function captureIdentities(): {
  operations: string[];
  tools: string[];
  exclusions: string[];
} {
  const doc = buildOpenApiDocument();
  const operations: string[] = [];
  const exclusions: string[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods as Record<string, Record<string, unknown>>)) {
      const identity = `${method.toUpperCase()} ${path}`;
      operations.push(identity);
      if (op["x-tool"] === false) exclusions.push(identity);
    }
  }
  return {
    operations: operations.sort(),
    tools: buildTools().map((t) => t.name).sort(),
    exclusions: exclusions.sort(),
  };
}

/** The package's captured system prompt, as the installed guard holds it. */
export const PACKAGE_PROMPT_PATH = "src/lib/plugins/fixtures/assistant-system.txt";
export function capturePackagePrompt(): { bytes: number; sha256: string } {
  const text = readFileSync(PACKAGE_PROMPT_PATH, "utf8");
  return { bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) };
}

/** Read a frozen baseline back, whole. */
export function frozen<T>(name: string): T {
  return JSON.parse(readFileSync(`${BASELINE_DIR}/${name}`, "utf8")) as T;
}
