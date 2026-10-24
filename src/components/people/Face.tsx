"use client";

import { useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import styles from "./Face.module.css";

/** Whose face it is: the person's SQL name and, while they have a picture,
 * its version, as the reads that draw a face carry it. */
export interface FaceOf {
  sqlName: string;
  pictureVersion?: string;
}

/** Where one version of a person's picture is read. */
export function pictureAddress(sqlName: string, version: string): string {
  return `/api/accounts/${encodeURIComponent(sqlName)}/picture?v=${encodeURIComponent(version)}`;
}

type Props = { person: FaceOf; letters: string; className: string } & Omit<HTMLAttributes<HTMLSpanElement>, "children" | "className">;

/**
 * A person's face in its host's circle: their picture, round, while they
 * have one, else the letters the host gives, by the host's own rule. The
 * letters stay until the picture has loaded and come back when it fails,
 * so the circle is never empty and a transparent picture shows the
 * circle's own colour, not letters. The host's class sizes, colours and
 * dims the circle. The face is decoration beside a name and says nothing
 * aloud. A person without a picture asks for none.
 */
export function Face({ person, letters, className, ...rest }: Props) {
  const src = person.pictureVersion ? pictureAddress(person.sqlName, person.pictureVersion) : null;
  const [outcome, setOutcome] = useState<{ src: string; loaded: boolean } | null>(null);
  const settled = src !== null && outcome?.src === src ? outcome.loaded : null;
  const image = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    // A picture the browser finished before anything listened (from its
    // cache, or before the page came alive) reports no load of its own.
    const drawn = image.current;
    if (src && drawn?.complete) setOutcome({ src, loaded: drawn.naturalWidth > 0 });
  }, [src]);
  return (
    <span {...rest} className={`${className} ${styles.face}`} aria-hidden data-face={settled ? "picture" : "letters"}>
      {!settled && letters}
      {src && settled !== false && (
        // The server's own private copy, read by version: nothing to optimise.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          ref={image}
          src={src}
          alt=""
          className={styles.picture}
          decoding="async"
          draggable={false}
          onLoad={() => setOutcome({ src, loaded: true })}
          onError={() => setOutcome({ src, loaded: false })}
        />
      )}
    </span>
  );
}
