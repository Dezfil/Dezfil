import gallery from "./gallery.module.css";

/** The most layer colours a card's count shows as dots. */
const MAX_LAYER_DOTS = 6;

/** A map's layers as colour dots, one per layer up to the few a card
 * shows; nothing for a map without layers. */
export function LayerDots({ colors }: { colors: string[] }) {
  if (colors.length === 0) return null;
  return (
    <span className={gallery.layerDots} aria-hidden>
      {colors.slice(0, MAX_LAYER_DOTS).map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

/** A map card's layer count in its body, beside the publication pill:
 * the layers' colour dots, then the count. */
export function LayerCount({ count, colors }: { count: number; colors: string[] }) {
  return (
    <span className={gallery.layerCount} data-layer-count>
      <LayerDots colors={colors} />
      <span>
        <span className={gallery.num}>{count}</span> layer{count === 1 ? "" : "s"}
      </span>
    </span>
  );
}
