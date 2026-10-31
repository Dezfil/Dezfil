import type { ToolDef } from "@/lib/tools/tools";

/**
 * The model-provider seam (two providers, Anthropic and OpenAI, granted by
 * API key; plan: one narrow abstraction so CI drives the agent loop with a
 * scripted stub and provider choice is a deployment setting).
 *
 * A provider exchange is stateful for the duration of one user request: the
 * agent loop sends the user turn, executes any tool calls, and continues
 * with outcomes until the model stops calling tools. Provider-native blocks
 * (e.g. Anthropic thinking blocks) stay inside the exchange, which keeps
 * each vendor's multi-turn replay rules satisfied without leaking vendor
 * shapes into the loop.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolOutcome {
  toolCallId: string;
  /** JSON-encoded result body the model reads. */
  body: string;
  isError: boolean;
  /** A native image beside the text: the map check's
   * rendered bytes, handed to the provider in its own image field and
   * never as text. Absent on every other outcome. */
  image?: ProviderImage;
}

/** Bytes the provider reads as an image, byte for byte as produced. */
export interface ProviderImage { mediaType: "image/png"; data: Uint8Array }

export interface ProviderReply {
  messageId?: string;
  model?: string;
  text: string;
  toolCalls: ToolCall[];
  /** The provider's own token report for the request that produced this
   * reply, where the wire supplies one; absent means unavailable, never
   * zero. */
  usage?: ProviderUsage;
}

export interface ProviderUsage { inputTokens: number; outputTokens: number }

/** The automatic check's continuation: a user turn
 * carrying text and the rendered image, answering no tool call. */
export interface ImageContinuation { text: string; image: ProviderImage }

/** Prior conversation turns, replayed as plain text (spec: conversations
 * are working state — only text survives across requests). */
export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ExchangeOptions {
  system: string;
  grounding?: string;
  tools: ToolDef[];
  history: HistoryTurn[];
}

export interface ProviderCallOptions { signal?: AbortSignal; onTextDelta?: (text: string) => void }

export interface ProviderExchange {
  /** Release native conversation buffers once the segment has settled. */
  dispose?(): void;
  retainedForTests?(): { history: unknown[]; grounding: string | undefined; tools: string[] };
  /** Replace application data while preserving native conversation blocks. */
  setGrounding?(grounding: string): void;
  /** Add tool definitions for this exchange's subsequent requests (spec
   * item 6): what discovery found stays callable on the next request and
   * across a confirmation continuation of the same exchange. A name
   * already offered is not added twice. */
  extendTools?(tools: ToolDef[]): void;
  /** Send the user's message (the exchange's first call). */
  send(userText: string, options?: ProviderCallOptions): Promise<ProviderReply>;
  /** Return tool outcomes and get the model's next reply. */
  continueWith(outcomes: ToolOutcome[], options?: ProviderCallOptions): Promise<ProviderReply>;
  /** Hand the model an image with a sentence of text as a user turn that
   * answers no tool call (the automatic check), and get its next reply.
   * */
  continueWithImage?(continuation: ImageContinuation, options?: ProviderCallOptions): Promise<ProviderReply>;
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  /** The effort this provider was built for: the provider's own
   * word, or absent when the request carries no setting at all. What it
   * means on the wire is each adapter's own business. */
  readonly effort?: string;
  exchange(options: ExchangeOptions): ProviderExchange;
}

/** Provider failures, mapped to actionable categories the API layer can
 * translate into documented error codes. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "provider",
    /** The provider's own words, behind the sentence a person reads. */
    public readonly detail?: string,
  ) {
    super(message);
  }
}
