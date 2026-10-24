import { open } from "node:fs/promises";
import { unsupportedImage } from "./limits";

/** The three kinds a picture may be. */
export type StillKind = "jpeg" | "png" | "webp";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEAD_BYTES = 4096;

/** The kind the bytes are, by their content alone; null for anything else. */
export function stillKind(head: Uint8Array): StillKind | null {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** What a refused file is, said plainly where its content says so. */
function otherKind(head: Buffer): string {
  if (head.toString("latin1", 0, 6) === "GIF87a" || head.toString("latin1", 0, 6) === "GIF89a") return "The file is a GIF image.";
  const text = head.toString("utf8").replace(/^﻿/, "").trimStart();
  if (text.startsWith("<") && /<svg[\s>]/i.test(text)) return "The file is an SVG image.";
  return "The file is not a JPEG, PNG or WebP image.";
}

/** Whether a PNG carries an animation control chunk before its first image
 * data, which an animated PNG must. Chunks are walked by their lengths;
 * a walk that runs out of file stops, and decoding judges the rest. */
async function animatedPng(file: import("node:fs/promises").FileHandle, size: number): Promise<boolean> {
  const header = Buffer.alloc(8);
  for (let position = PNG_SIGNATURE.length; position + 8 <= size;) {
    const { bytesRead } = await file.read(header, 0, 8, position);
    if (bytesRead < 8) return false;
    const type = header.toString("latin1", 4, 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    position += 12 + header.readUInt32BE(0);
  }
  return false;
}

/** Read the file's kind from its content, never its name or declared type.
 * Refuses anything but the three kinds, and an animated PNG, before any
 * image library reads it. */
export async function recognisePicture(path: string): Promise<StillKind> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await file.read(head, 0, head.length, 0);
    const kind = stillKind(head);
    if (!kind) throw unsupportedImage(otherKind(head));
    if (kind === "png" && await animatedPng(file, size)) throw unsupportedImage("The image is animated.");
    return kind;
  } finally {
    await file.close();
  }
}
