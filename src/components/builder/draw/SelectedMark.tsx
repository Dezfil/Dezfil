import styles from "./draw.module.css";

/**
 * How a selected drawn shape stands out from the others on the map: a
 * thicker outline in the accent over a soft glow, a wider low-opacity
 * accent stroke beneath it. A thin casing in the panel colour between the
 * two keeps the outline readable over a light or a dark basemap in either
 * theme. A traced shape (a polygon, rectangle, circle, freehand or line)
 * passes its path; a point passes the ring around it.
 */
export function SelectedMark(
  props: { d: string } | { cx: number; cy: number; r: number },
) {
  const layer = (className: string) =>
    "d" in props ? (
      <path className={className} d={props.d} />
    ) : (
      <circle className={className} cx={props.cx} cy={props.cy} r={props.r} />
    );
  return (
    <g data-selection-mark>
      {layer(styles.selectGlow)}
      {layer(styles.selectCasing)}
      {layer(styles.selectLine)}
    </g>
  );
}
