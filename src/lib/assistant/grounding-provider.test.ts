import { responseWire, outputCall, outputText, anthropicWire } from "./testing/wire";
import { describe, expect, it } from "vitest";
import { openaiProvider } from "./providers/openai";
import { anthropicProvider } from "./providers/anthropic";

describe("grounding in provider-native continuations", () => {
  for (const vendor of ["openai", "anthropic"] as const) {
    it(`${vendor} replaces the data snapshot and preserves native tool blocks`, async () => {
      const native = vendor === "openai"
        ? [outputText("Reading"), outputCall("call-fresh", "run_sql", '{"sql":"SELECT 1"}')]
        : [
            { type: "thinking", thinking: "private", signature: "signed-native-block" },
            { type: "text", text: "Reading" },
            { type: "tool_use", id: "call-fresh", name: "run_sql", input: { sql: "SELECT 1" } },
          ];
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const first = bodies.length === 1;
        const response = vendor === "openai"
          ? { id: "reply", object: "chat.completion", created: 0, model: "fixture", choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", message: first ? native : { role: "assistant", content: "Done" } }] }
          : { id: "reply", type: "message", role: "assistant", model: "fixture", stop_reason: first ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: first ? native : [{ type: "text", text: "Done" }] };
        return vendor === "openai" ? responseWire(first ? native : [outputText("Done")]) : anthropicWire(response as Parameters<typeof anthropicWire>[0]);
      };
      const provider = (vendor === "openai" ? openaiProvider : anthropicProvider)("fixture-key", "fixture-model", fetchImpl);
      const exchange = provider.exchange({ system: "Trusted application instructions", grounding: '{"snapshot":"FIRST_DATA"}', tools: [], history: [{ role: "user", text: "Exact prior text" }] });
      await exchange.send("Exact new text");
      expect(JSON.stringify(bodies[0][vendor === "openai" ? "input" : "messages"])).toContain("FIRST_DATA");
      exchange.setGrounding!('{"snapshot":"SECOND_DATA"}');
      await exchange.continueWith([{ toolCallId: "call-fresh", body: '{"value":1}', isError: false }]);
      const followup = bodies[1][vendor === "openai" ? "input" : "messages"] as { role: string; content: unknown }[];
      expect(JSON.stringify(followup)).toContain("SECOND_DATA");
      expect(JSON.stringify(followup)).not.toContain("FIRST_DATA");
      const dataTurn = followup.find((turn) => String(turn.content).includes("SECOND_DATA"));
      expect(dataTurn?.role).toBe("user");
      if (vendor === "openai") {
        expect(bodies[1].instructions).toBe("Trusted application instructions");
        expect(followup).toEqual(expect.arrayContaining(native as unknown[]));
      } else {
        expect(bodies[1].system).toBe("Trusted application instructions");
        expect(followup.find((turn) => turn.role === "assistant")?.content).toEqual(native);
      }
      expect(JSON.stringify(followup)).toContain("Exact prior text");
      expect(JSON.stringify(followup)).toContain("Exact new text");
    });
  }
});
