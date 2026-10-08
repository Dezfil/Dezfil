import type { BasemapKey } from "@/lib/basemap";
import styles from "./BasemapThumb.module.css";

/** The five choices a basemap picker offers, in one order both surfaces
 * use: Auto first, because it is the default a map starts on. */
export type ThumbStyle = BasemapKey | "auto";

/**
 * A basemap's thumbnail — a capture of the style itself, shared by the
 * builder's basemap panel and the published viewer's picker so the same
 * style looks the same wherever it is offered.
 *
 * Auto is drawn as its two outcomes split on the diagonal, since it has
 * no single appearance of its own: what it looks like depends on the
 * theme in effect.
 */
/** The styles a capture ships for. The three vector captures are of the
 * styles themselves. Imagery is configured per instance, so its capture
 * cannot be of the service in use: it is a public-domain global mosaic,
 * standing for imagery as a kind. A style absent here falls back to its
 * gradient. */
const CAPTURED: BasemapKey[] = ["dark", "light", "streets", "satellite"];

export function BasemapThumb({
  style,
  fill = false,
}: {
  style: ThumbStyle;
  /** Fill the box it sits in, which draws the edge: a settings picture
   * card's, sized by its card rather than at the panels' fixed height. */
  fill?: boolean;
}) {
  const url = (key: BasemapKey) =>
    CAPTURED.includes(key) ? `url(/basemaps/thumbs/${key}.webp)` : undefined;
  return (
    <span
      className={styles.thumb}
      data-style={style}
      data-fill={fill || undefined}
      aria-hidden
    >
      {style === "auto" ? (
        <>
          <span
            className={styles.half}
            data-half="dark"
            style={{ backgroundImage: url("dark") }}
          />
          <span
            className={styles.half}
            data-half="light"
            style={{ backgroundImage: url("light") }}
          />
        </>
      ) : (
        <span
          className={styles.half}
          style={{ backgroundImage: url(style) }}
        />
      )}
    </span>
  );
}
