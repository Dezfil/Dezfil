import { ApiError } from "@/lib/api/errors";

/** A profile picture's bounds. They are fixed: none is a setting. */
export const PICTURE_LIMITS = Object.freeze({
  /** The largest file accepted, 10 MB at 1,048,576 bytes to the MB. */
  fileBytes: 10 * 1024 * 1024,
  /** What a multipart body may carry around the file. */
  envelopeBytes: 64 * 1024,
  /** The most pixels an image may declare. */
  pixels: 64_000_000,
  /** The stored square's side: three screen pixels per point at its
   * largest display, 96 points. */
  side: 320,
  /** How long the body may take to arrive. */
  receiveMs: 60_000,
  /** How long processing may take, counted from the end of reception and
   * covering the wait for a turn. */
  processMs: 20_000,
  /** How many pictures may wait while one is processed. */
  waiting: 8,
});

export const STILL_KINDS = "a still JPEG, PNG or WebP image";
const choose = `Choose ${STILL_KINDS}.`;

/** The reception bounds' wording: the limit is fixed, so no setting is named. */
export const tooLargeMessage = () =>
  `The file is over the 10 MB limit for a picture, which is fixed. ${choose}`;
export const RECEPTION_REMEDY = "The limit is fixed.";

export function unsupportedImage(what: string): ApiError {
  return new ApiError("unsupported_image", `${what} ${choose}`, 415);
}

export function imageTooLarge(width: number, height: number): ApiError {
  const size = `${width.toLocaleString("en-US")} by ${height.toLocaleString("en-US")} pixels`;
  return new ApiError("image_too_large",
    `The image is ${size}, over the fixed limit of 64 million. Choose a smaller still JPEG, PNG or WebP image.`, 413);
}

export function processingTimeout(ms: number): ApiError {
  return new ApiError("data_processing_timeout",
    `The picture took longer than the ${ms / 1000} s limit for processing one, which is fixed. Try again, or choose a smaller image.`, 408);
}

export function pictureQueueFull(): ApiError {
  return new ApiError("operation_queue_full",
    `${PICTURE_LIMITS.waiting} pictures are already waiting to be processed. Try again in a moment.`, 503);
}
