"use client";

import { useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from "react";

/**
 * A card's picture over its placeholder, marked once the browser has
 * drawn it, so the strip drops its fade over a picture and keeps it over
 * the placeholder while the picture is still on its way. A new address
 * waits for its own load; a failure is the host's to answer, by leaving
 * the placeholder alone. A picture the browser already holds whole when
 * the image mounts or changes address, a cached one, is marked at once.
 */
export function PictureImage({
  address,
  onFailed,
  ...image
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "onLoad" | "onError"> & {
  /** What the image asks for, its sizes included: a change waits for a new load. */
  address: string;
  onFailed: () => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  useLayoutEffect(() => {
    const drawn = ref.current;
    if (drawn && drawn.complete === true && drawn.naturalWidth > 0) setLoaded(address);
  }, [address]);
  return (
    // Same-origin pictures; next/image would only add an optimizer hop.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      {...image}
      alt=""
      data-loaded={loaded === address ? "" : undefined}
      onLoad={() => setLoaded(address)}
      onError={onFailed}
    />
  );
}
