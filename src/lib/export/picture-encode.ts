import type { Page } from "puppeteer-core";
import type { PictureFrame } from "@/lib/pictures/framing";

/** One kept size of a picture and the format it is kept in. */
export interface PictureSize {
  width: number;
  height: number;
  type: "image/webp" | "image/png";
}

/** What a map picture's render adds to an export's: the frame the page
 * draws it in, and the sizes kept from the master. */
export interface PictureRenderRequest {
  frame: PictureFrame;
  sizes: PictureSize[];
  /** WebP quality, 0 to 1. */
  quality: number;
}

/** Just enough of the page to run a function in it. */
type EncodingPage = Pick<Page, "evaluate">;

/**
 * The kept sizes of a rendered master, in the order asked, reduced at the
 * browser's high quality and encoded by the renderer's own browser before
 * it closes, so the server needs no image library and runs no image work
 * on its event loop. A browser that answers another format than asked
 * fails the render rather than storing it under the wrong name.
 */
export async function encodePictureSizes(page: EncodingPage, png: Uint8Array, request: PictureRenderRequest): Promise<Uint8Array[]> {
  const answers = await page.evaluate(async (master: string, sizes: PictureSize[], quality: number) => {
    const bytes = Uint8Array.from(atob(master), (c) => c.charCodeAt(0));
    const source = new Blob([bytes], { type: "image/png" });
    const out: string[] = [];
    for (const size of sizes) {
      const reduced = await createImageBitmap(source, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
      const canvas = new OffscreenCanvas(size.width, size.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The picture could not be encoded: no 2D canvas.");
      context.drawImage(reduced, 0, 0);
      reduced.close();
      const blob = await canvas.convertToBlob(size.type === "image/webp" ? { type: size.type, quality } : { type: size.type });
      if (blob.type !== size.type) throw new Error(`The picture could not be encoded: the browser answered ${blob.type}.`);
      const encoded = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (let i = 0; i < encoded.length; i += 0x8000) text += String.fromCharCode(...encoded.subarray(i, i + 0x8000));
      out.push(btoa(text));
    }
    return out;
  }, Buffer.from(png).toString("base64"), request.sizes, request.quality);
  return answers.map((answer) => new Uint8Array(Buffer.from(answer, "base64")));
}

/** A WebP file's pixel size from its header, or null when the bytes are
 * not a WebP image this reads (lossy, lossless or extended). */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 30 || view.toString("latin1", 0, 4) !== "RIFF" || view.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = view.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    if (view[23] !== 0x9d || view[24] !== 0x01 || view[25] !== 0x2a) return null;
    return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (view[20] !== 0x2f) return null;
    const bits = view.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: view.readUIntLE(24, 3) + 1, height: view.readUIntLE(27, 3) + 1 };
  }
  return null;
}
