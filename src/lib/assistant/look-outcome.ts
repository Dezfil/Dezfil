import type { LookFacts } from "@/lib/export/map-look";
import type { ProviderImage } from "./provider";

/**
 * The map check's outcome, shaped for its three readers: the model gets
 * the facts as text and the image in the provider's native image field;
 * the event stream and the receipt get the facts and never the bytes; a
 * headless client keeps the documented body. The operation is recognised
 * by its documented tool name; every other outcome passes through
 * untouched.
 */
export const LOOK_TOOL = "look_at_map";

/** What the model's text says beside the native image: a fact, not an instruction. */
const IMAGE_NOTE = "The rendered image is attached to this result as an image.";

export interface ShapedLookOutcome {
  /** The body the model reads as text. */
  modelBody: unknown;
  /** The body the events carry: the facts, no bytes. */
  eventBody: unknown;
  render?: LookFacts;
  image?: ProviderImage;
  /** A check that could not run is not done, never
   * uncertain: a read leaves no mutation's result unknown. */
  outcome?: "refused";
}

interface LookBody { render?: LookFacts; image?: { content_type?: string; width?: number; height?: number; bytes?: number; content_base64?: string } }

export function shapeLookOutcome(tool: string, ok: boolean, body: unknown): ShapedLookOutcome {
  if (tool !== LOOK_TOOL) return { modelBody: body, eventBody: body };
  if (!ok) return { modelBody: body, eventBody: body, outcome: "refused" };
  if (!body || typeof body !== "object") return { modelBody: body, eventBody: body };
  const answer = body as LookBody;
  if (!answer.render || typeof answer.image?.content_base64 !== "string") return { modelBody: body, eventBody: body };
  const image: ProviderImage = { mediaType: "image/png", data: new Uint8Array(Buffer.from(answer.image.content_base64, "base64")) };
  const facts = { render: answer.render };
  return {
    modelBody: { ...facts, image: IMAGE_NOTE },
    eventBody: facts,
    render: answer.render,
    image,
  };
}
