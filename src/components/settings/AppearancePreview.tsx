"use client";
import { useState, type CSSProperties } from "react";
import { useTheme } from "@/components/theme";
import { AnalyzeIcon, LayersIcon, MinusIcon, PlusIcon, SlidersIcon, SparkleIcon } from "@/components/ui/icons";
import styles from "./AppearancePreview.module.css";

/** The shipped template whose picture the preview's map is. */
export const PREVIEW_TEMPLATE = "air-routes";

/** The picture's address in a theme: the template picture route, whose
 * picture carries its own credit at its lower edge. */
export const previewPicture = (theme: "light" | "dark") => `/api/templates/${PREVIEW_TEMPLATE}/picture?theme=${theme}`;

/**
 * A small builder over a map, above Appearance's cards: the header, the
 * side menu, the inspector and its layers, the map buttons, two widget
 * cards and the legend, each drawn by its own surface role, so the preview
 * follows every pick and the theme as the builder does, the moment the
 * root changes. The card around it is solid; without the picture the map
 * is the page's ground.
 */
export function AppearancePreview() {
  const { theme } = useTheme();
  const src = previewPicture(theme);
  const [failed, setFailed] = useState<string | null>(null);
  return <figure className={styles.preview} data-appearance-preview="">
    <figcaption className={styles.heading}>Preview</figcaption>
    <div className={styles.scene} aria-hidden="true">
      {failed !== src && (
        // Same-origin PNG; next/image would only add an optimizer hop.
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.map} src={src} alt="" onError={() => setFailed(src)} />
      )}
      <div className={`${styles.head} ${styles.chrome}`}>
        <b className={styles.logo}>Dezfil</b><span>Maps</span><span>/</span><b>The world&apos;s air routes</b>
      </div>
      <div className={styles.tools}>
        <span className={styles.chrome}>Assistant</span><span className={styles.chrome}>Tools</span>
        <span className={styles.publish}>Publish</span>
      </div>
      <div className={`${styles.rail} ${styles.chrome}`}>
        <i data-on=""><LayersIcon /></i><i><AnalyzeIcon /></i><i><SparkleIcon /></i><i><SlidersIcon /></i>
      </div>
      <div className={`${styles.inspector} ${styles.panel}`}>
        <div className={styles.tabs}><b>Layers</b><span>Basemap</span><span>Widgets</span></div>
        <Layer swatch="#f4f4f4" name="Airports" count="3,257 features" />
        <Layer swatch="#f29e38" name="Air routes, June 2014" count="18,930 features" />
        <span className={styles.faint}>Saved just now</span>
      </div>
      <div className={styles.buttons}>
        <span className={styles.control}><PlusIcon /></span><span className={styles.control}><MinusIcon /></span>
      </div>
      <div className={styles.widgets}>
        <div className={`${styles.widget} ${styles.mapCard}`}><small>Airport pairs</small><b>18,930</b></div>
        <div className={`${styles.widget} ${styles.mapCard}`}>
          <small>Haul, by distance</small>
          <Bar name="Short" value="11.6k" share={92} /><Bar name="Medium" value="5,625" share={45} /><Bar name="Long" value="1,719" share={14} />
        </div>
      </div>
      <div className={`${styles.legend} ${styles.overlay}`}>
        <b>Air routes, June 2014</b>
        <span><i style={{ background: "#f29e38" }} />busier airport</span>
        <span><i style={{ background: "#4f86e8" }} />other airport</span>
      </div>
    </div>
  </figure>;
}

function Layer({ swatch, name, count }: { swatch: string; name: string; count: string }) {
  return <div className={`${styles.layer} ${styles.inner}`}>
    <i style={{ background: swatch }} /><span><b>{name}</b><small>{count}</small></span>
  </div>;
}

function Bar({ name, value, share }: { name: string; value: string; share: number }) {
  return <span className={styles.bar}><span>{name}</span><i style={{ "--share": `${share}%` } as CSSProperties} /><em>{value}</em></span>;
}
