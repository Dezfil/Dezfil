/** SDK wire fixtures, distinct from scripted model-orchestration fixtures. */
export function sse(events: unknown[], anthropic = false) {
  return new Response(events.map((event) => `${anthropic ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
export function responseWire(output: unknown[], model = "gpt-6-astra") {
  return sse([{ type: "response.completed", response: { id: "response", status: "completed", model, output } }]);
}
export const outputText = (text: string) => ({ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
export const outputCall = (call_id: string, name: string, args: string) => ({ type: "function_call", id: `item-${call_id}`, call_id, name, arguments: args, status: "completed" });
export function anthropicEvents(content: unknown[], stop_reason = "end_turn", model = "claude-opus-5"): unknown[] {
  return [
    { type: "message_start", message: { id: "message", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...content.flatMap((block, index) => [{ type: "content_block_start", index, content_block: block }, { type: "content_block_stop", index }]),
    { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
}
export function anthropicWire(response: { content: unknown[]; stop_reason: string; model: string }) { return sse(anthropicEvents(response.content, response.stop_reason, response.model), true); }
