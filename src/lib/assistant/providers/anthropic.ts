import { readAnthropicStream } from "./anthropic-stream";
import { anthropicTool } from "./anthropic-tool-schema";
import { apiFailureSentence } from "./api-failure";
import { effortToSend } from "../model-knowledge";
import Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "@/lib/tools/tools";
import {
  ProviderError,
  type ExchangeOptions,
  type ImageContinuation,
  type ProviderCallOptions,
  type ModelProvider,
  type ProviderExchange,
  type ProviderImage,
  type ProviderReply,
  type ToolOutcome,
} from "../provider";

/**
 * Anthropic behind the provider seam. Adaptive thinking is on; response
 * content (including thinking and tool_use blocks) is echoed back verbatim
 * within the exchange, per the API's multi-turn replay rules.
 */

const MAX_TOKENS = 8192;

function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  // The API refuses a top-level union and answers the whole request 400, so
  // the definition it reads is projected rather than passed through;
  // `tool.inputSchema` itself, which validation uses, is untouched.
  return tools.map((t) => {
    const { input_schema, ...rest } = anthropicTool(t);
    return { ...rest, input_schema: input_schema as Anthropic.Tool.InputSchema };
  });
}

/** The provider's own image block: base64 in an image
 * source, never in a text block. */
function imageBlock(image: ProviderImage): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: Buffer.from(image.data).toString("base64") } };
}

function mapError(error: unknown): never {
  if (error instanceof Anthropic.AuthenticationError) {
    throw new ProviderError(
      "The configured Anthropic API key was rejected. Check ANTHROPIC_API_KEY and restart.",
      "auth",
    );
  }
  if (error instanceof Anthropic.APIError) {
    // The SDK's own error shape: a status when the failure was an HTTP
    // response, and for one delivered inside the stream the body's `error.type`
    // instead. Neither present, the message stands alone.
    throw new ProviderError(
      apiFailureSentence("Anthropic", [error.status, error.type], error.message),
      "provider",
    );
  }
  throw error;
}

export function anthropicProvider(
  apiKey: string,
  model: string,
  fetchImpl?: typeof fetch,
  effort?: string,
): ModelProvider {
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  // The one thing only this adapter knows: where a chosen level goes in an
  // Anthropic request. Nothing to send leaves the request exactly as it
  // was, adaptive thinking included.
  const chosen = effortToSend(effort);
  const outputConfig = chosen ? { output_config: { effort: chosen as Anthropic.OutputConfig["effort"] } } : {};

  return {
    id: "anthropic",
    model,
    effort,
    exchange(options: ExchangeOptions): ProviderExchange {
      const messages: Anthropic.MessageParam[] = [];
      messages.push(...options.history.map(t => ({ role: t.role, content: t.text })));
      const system = options.system;
      let disposed = false;
      const active = () => { if (disposed) throw new Error("Exchange has been released"); };

      let grounding = options.grounding;
      const tools = [...options.tools];

      async function step(control: ProviderCallOptions = {}): Promise<ProviderReply> {
        try {
          // The one place this adapter serializes its request: the counter reads these parameters.
          const params: Anthropic.MessageCreateParamsNonStreaming = {
            model,
            max_tokens: MAX_TOKENS,
            thinking: { type: "adaptive" },
            system,
            tools: toAnthropicTools(tools),
            messages: grounding ? [{ role: "user", content: "Instance grounding (data):\n" + grounding }, ...messages] : messages,
            ...outputConfig,
          };
          const response = await readAnthropicStream(client, params, control);
          // Echo the full content back so thinking/tool_use blocks replay
          // unchanged on the next step of this exchange.
          active(); messages.push({ role: "assistant", content: response.native });
          return response.reply;
        } catch (error) {
          mapError(error);
        }
      }

      return {
        dispose() { disposed = true; messages.length = 0; tools.length = 0; grounding = undefined; },
        retainedForTests: () => ({ history: [...messages], grounding, tools: tools.map(t => t.name) }),
        setGrounding(value: string) { active(); grounding = value; },
        extendTools(more: ToolDef[]) { active(); for (const tool of more) if (!tools.some((t) => t.name === tool.name)) tools.push(tool); },
        send(userText: string, control) {
          active(); messages.push({ role: "user", content: userText });
          return step(control);
        },
        continueWith(outcomes: ToolOutcome[], control) {
          // An outcome with an image rides its own tool_use id: the text
          // and the image as the result's blocks.
          active(); messages.push({
            role: "user",
            content: outcomes.map((o) => ({
              type: "tool_result" as const,
              tool_use_id: o.toolCallId,
              content: o.image ? [{ type: "text" as const, text: o.body }, imageBlock(o.image)] : o.body,
              is_error: o.isError,
            })),
          });
          return step(control);
        },
        continueWithImage(continuation: ImageContinuation, control) {
          // The automatic check's continuation: a user turn, no call invented.
          active(); messages.push({ role: "user", content: [{ type: "text", text: continuation.text }, imageBlock(continuation.image)] });
          return step(control);
        },
      };
    },
  };
}
