import Anthropic from "@anthropic-ai/sdk";
import type { ProviderCallOptions, ProviderReply } from "../provider";
import { completeArguments, incompleteReply } from "./complete-call";

export async function readAnthropicStream(client: Anthropic, params: Anthropic.MessageCreateParamsNonStreaming, control: ProviderCallOptions = {}): Promise<{ reply: ProviderReply; native: Anthropic.ContentBlock[] }> {
  const stream = client.messages.stream(params, { signal: control.signal });
  const argumentsByIndex = new Map<number, string>();
  const closedBlocks = new Set<number>();
  let stopped = false;
  for await (const event of stream) {
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") control.onTextDelta?.(event.delta.text);
      if (event.delta.type === "input_json_delta") argumentsByIndex.set(event.index, (argumentsByIndex.get(event.index) ?? "") + event.delta.partial_json);
    }
    if (event.type === "content_block_stop") closedBlocks.add(event.index);
    if (event.type === "message_stop") stopped = true;
  }
  if (control.signal?.aborted) throw control.signal.reason;
  if (!stopped) incompleteReply();
  const response = await stream.finalMessage();
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const usage = response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } : undefined;
  if (response.stop_reason === "refusal") return { native: response.content, reply: { text: text || "The model declined this request.", toolCalls: [], model: response.model, ...(usage ? { usage } : {}) } };
  if (!["end_turn", "tool_use", "stop_sequence"].includes(response.stop_reason ?? "")) incompleteReply();
  const toolCalls = response.content.flatMap((block, index) => {
    if (block.type !== "tool_use") return [];
    if (!closedBlocks.has(index) || !block.id || !block.name) incompleteReply();
    // A call that takes no arguments streams an empty argument text, and an
    // empty string is not nothing: kept and parsed it threw, and the whole
    // reply went with it. The SDK's own accumulator guards the empty buffer
    // and leaves `input` as `{}`, so the streamed text is trusted only when
    // it carries something. Truncation is not affected: a call whose block
    // never closed is refused on the line above, before this reads anything.
    const streamed = argumentsByIndex.get(index);
    const args = completeArguments(streamed || JSON.stringify(block.input));
    return [{ id: block.id, name: block.name, args }];
  });
  return { native: response.content, reply: { text, toolCalls, model: response.model, ...(usage ? { usage } : {}) } };
}
