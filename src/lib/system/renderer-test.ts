import { ApiError } from "@/lib/api/errors";
import type { AuthContext } from "@/lib/auth/credentials";
import { delegateCredential } from "@/lib/auth/delegation";
import { decodePng, type DecodedImage } from "@/lib/export/png-codec";
import {
  RENDER_CHECK_GROUND_COLOR,
  RENDER_CHECK_MARK,
  RENDER_CHECK_MARK_COLOR,
  RENDER_CHECK_SIZE,
} from "@/lib/export/render-check";
import { chromiumPath } from "@/lib/export/render-drive";
import { renderCheckImage } from "@/lib/export/render-image";
import { executableFound } from "./executable";

/**
 * The image renderer's Test: the browser as configured now photographs
 * the render route's fixed check picture, and the image is read back at
 * the mark and on the ground. It runs only on an image slot free now with
 * no image waiting, else answers busy at once, launching nothing; past
 * its limit the browser is killed and the slot given back.
 */

/** How far a channel may stray from the drawn color. */
const TOLERANCE = 16;

function colorAt(image: DecodedImage, x: number, y: number): [number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]];
}
const matches = (actual: readonly number[], expected: readonly number[]) =>
  actual.every((value, i) => Math.abs(value - expected[i]) <= TOLERANCE);

/** The picture as drawn: its size, the mark's color at the mark's centre,
 * the ground's in a corner. */
export function showsCheckPicture(png: Uint8Array): boolean {
  let image: DecodedImage;
  try { image = decodePng(png); } catch { return false; }
  if (image.width !== RENDER_CHECK_SIZE.width || image.height !== RENDER_CHECK_SIZE.height) return false;
  const mark = colorAt(image, RENDER_CHECK_MARK.x + Math.floor(RENDER_CHECK_MARK.width / 2), RENDER_CHECK_MARK.y + Math.floor(RENDER_CHECK_MARK.height / 2));
  const ground = colorAt(image, 5, 5);
  return matches(mark, RENDER_CHECK_MARK_COLOR) && matches(ground, RENDER_CHECK_GROUND_COLOR);
}

export async function renderTestImage(
  context: AuthContext,
  baseUrl: string,
  limitMs: number,
  signal: AbortSignal,
): Promise<"rendered" | "not_found" | "busy" | "timed_out" | "failed"> {
  if (!executableFound(chromiumPath())) return "not_found";
  let image;
  try {
    image = await renderCheckImage({
      baseUrl, credential: delegateCredential(context), accountId: context.account.id, timeoutMs: limitMs, signal,
    });
  } catch (error) {
    return error instanceof ApiError && error.code === "render_timeout" ? "timed_out" : "failed";
  }
  if (image === "busy") return "busy";
  return showsCheckPicture(image.png) ? "rendered" : "failed";
}
