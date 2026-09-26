import type { ToolDef } from "@/lib/tools/tools";
import {
  type ExchangeOptions,
  type ImageContinuation,
  type ModelProvider,
  type ProviderExchange,
  type ProviderReply,
  type ToolOutcome,
} from "../provider";

/**
 * The scripted model stub behind the provider seam (plan: CI drives the
 * agent loop deterministically; real-provider runs are release checks).
 * Replies are consumed in order; everything the "model" was shown is
 * recorded for assertions. A reply may be a function of the tool outcomes
 * that preceded it, so a scripted "model" can read a real id from a prior
 * tool result exactly as a real model would.
 */

/** A scripted reply may read the tool outcomes that preceded it and the
 * definitions the model is offered at that request: a script that selects
 * from the offer cannot call what it was not shown. */
export type ScriptEntry =
  | ProviderReply
  | ((outcomes: ToolOutcome[], offered: ToolDef[]) => ProviderReply);

export interface StubRecording {
  exchanges: {
    options: ExchangeOptions;
    userText?: string;
    outcomes: ToolOutcome[][];
    groundings: (string | undefined)[];
    /** The definitions added by discovery, per extension. */
    extensions: ToolDef[][];
    /** The definitions offered at each request, in order. */
    offered: ToolDef[][];
    /** The image-bearing continuations, in order. */
    images?: ImageContinuation[];
  }[];
}

export function stubProvider(
  script: ScriptEntry[],
  recording: StubRecording = { exchanges: [] },
): ModelProvider & { recording: StubRecording } {
  let cursor = 0;
  // Real providers mint a fresh tool-call id per exchange. Scripts that
  // reuse an id would re-legitimize the masking that hid so the stub
  // refuses them outright.
  const issued = new Set<string>();
  const next = (outcomes: ToolOutcome[], offered: ToolDef[]): ProviderReply => {
    if (cursor >= script.length) {
      throw new Error(
        `Stub script exhausted after ${script.length} replies; the loop asked for more.`,
      );
    }
    const entry = script[cursor++];
    const reply = typeof entry === "function" ? entry(outcomes, offered) : entry;
    for (const call of reply.toolCalls) {
      if (issued.has(call.id)) {
        throw new Error(
          `Stub script reuses tool-call id "${call.id}"; real providers mint fresh ids, and tests must too.`,
        );
      }
      issued.add(call.id);
    }
    return reply;
  };

  return {
    id: "stub",
    model: "scripted",
    recording,
    exchange(options: ExchangeOptions): ProviderExchange {
      const record: StubRecording["exchanges"][number] = {
        options,
        outcomes: [],
        groundings: [],
        extensions: [],
        offered: [],
      };
      recording.exchanges.push(record);
      let grounding = options.grounding;
      const tools = [...options.tools];
      return {
        setGrounding(value: string) { grounding = value; },
        extendTools(more: ToolDef[]) {
          const added = more.filter((tool) => !tools.some((t) => t.name === tool.name));
          tools.push(...added);
          record.extensions.push(added);
        },
        async send(userText: string) {
          record.userText = userText;
          record.groundings.push(grounding);
          record.offered.push([...tools]);
          return next([], [...tools]);
        },
        async continueWith(outcomes: ToolOutcome[]) {
          record.outcomes.push(outcomes);
          record.groundings.push(grounding);
          record.offered.push([...tools]);
          return next(outcomes, [...tools]);
        },
        async continueWithImage(continuation: ImageContinuation) {
          // The automatic check's continuation: recorded decoded, so a
          // suite asserts the bytes the model was handed.
          (record.images ??= []).push(continuation);
          record.groundings.push(grounding);
          record.offered.push([...tools]);
          return next([], [...tools]);
        },
      };
    },
  };
}
