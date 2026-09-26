import OpenAI from "openai";
import type { ExchangeOptions, ImageContinuation, ProviderCallOptions, ProviderExchange, ProviderImage, ProviderReply, ToolOutcome } from "../provider";
import { completeArguments, incompleteReply } from "./complete-call";
import { effortToSend } from "../model-knowledge";

/** The provider's own image field: a data URL inside an
 * input_image item, never text. */
function imageItem(image: ProviderImage): OpenAI.Responses.ResponseInputImage {
  return { type: "input_image", detail: "auto", image_url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}` };
}

/** Native Responses continuation stays in this process, including encrypted
 * reasoning items; grounding is fresh application data on each exchange. */
export function responsesExchange(client: OpenAI, model: string, options: ExchangeOptions, effort?: string): ProviderExchange {
  const input: OpenAI.Responses.ResponseInput = options.history.map((t) => ({ role: t.role, content: t.text }));
  // The one thing only this adapter knows: where a chosen level goes in an
  // OpenAI request. Nothing to send leaves the request exactly as it was
  // before the choice existed.
  const chosen = effortToSend(effort);
  const reasoning = chosen ? { reasoning: { effort: chosen as OpenAI.ReasoningEffort } } : {};
  let grounding = options.grounding;
  const tools = [...options.tools];
  async function step(control: ProviderCallOptions = {}): Promise<ProviderReply> {
    // The one place this adapter serializes its request.
    const params = {
      model, stream: true as const, store: false, background: false, max_output_tokens: 8192,
      include: ["reasoning.encrypted_content" as const], instructions: options.system,
      tools: tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.inputSchema, strict: false })),
      input: grounding ? [{ role: "user" as const, content: "Instance grounding (data):\n" + grounding }, ...input] : input,
      ...reasoning,
    };
    const stream = await client.responses.create(params, { signal: control.signal });
    let response: OpenAI.Responses.Response | undefined;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") control.onTextDelta?.(event.delta);
      if (event.type === "response.completed") response = event.response;
      if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") incompleteReply();
    }
    if (control.signal?.aborted) throw control.signal.reason;
    if (!response || response.status !== "completed") incompleteReply();
    const messages = response.output.filter((item) => item.type === "message");
    const text = messages.flatMap((item) => item.content.flatMap((part) => part.type === "output_text" ? [part.text] : part.type === "refusal" ? [part.refusal] : [])).join("");
    const refused = messages.some((item) => item.content.some((part) => part.type === "refusal"));
    const calls = refused ? [] : response.output.filter((item) => item.type === "function_call").map((item) => {
      if (item.status !== "completed" || !item.call_id || !item.name) incompleteReply();
      return { id: item.call_id, name: item.name, args: completeArguments(item.arguments) };
    });
    input.push(...response.output.filter((item) => item.type === "message" || item.type === "reasoning" || item.type === "function_call"));
    const usage = response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } : undefined;
    return { text, toolCalls: calls, model: response.model, ...(usage ? { usage } : {}) };
  }
  return {
    setGrounding(value) { grounding = value; },
    extendTools(more) { for (const tool of more) if (!tools.some((t) => t.name === tool.name)) tools.push(tool); },
    send(text, control) { input.push({ role: "user", content: text }); return step(control); },
    continueWith(outcomes: ToolOutcome[], control) {
      // An outcome with an image rides its own call identity: the text
      // and the image as the output's items.
      input.push(...outcomes.map((o) => ({
        type: "function_call_output" as const, call_id: o.toolCallId,
        output: o.image ? [{ type: "input_text" as const, text: o.body }, imageItem(o.image)] : o.body,
      })));
      return step(control);
    },
    continueWithImage(continuation: ImageContinuation, control) {
      // The automatic check's continuation: a user turn, no call invented.
      input.push({ role: "user", content: [{ type: "input_text", text: continuation.text }, imageItem(continuation.image)] });
      return step(control);
    },
  };
}
