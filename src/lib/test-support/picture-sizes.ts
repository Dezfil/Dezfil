import type { PictureImages } from "@/lib/pictures/card";
import { PICTURE_SHAPE_NAMES, PICTURE_SHAPES } from "@/lib/pictures/shapes";

/** A whole picture as the service publishes it: the card's PNG and every
 * kept size of both shapes, each file's bytes naming what it is, so a read
 * shows which one it picked. A test that publishes bare PNG bytes instead
 * stands for a picture made before sizes were kept. */
export function sizedPicture(tag: string, png: Uint8Array = Buffer.from(`${tag}:png`)): PictureImages {
  return {
    png,
    sized: PICTURE_SHAPE_NAMES.flatMap((shape) => PICTURE_SHAPES[shape].widths.map((width) => ({
      shape, width, height: 1, bytes: Buffer.from(`${tag}:${shape}-${width}`),
    }))),
  };
}
