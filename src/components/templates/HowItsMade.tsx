"use client";

import { useRef, useState, type ReactNode } from "react";
import type { Layer } from "@/lib/metadata/maps";
import { layerCount, layerKind, layerSwatch } from "@/lib/layer-summary";
import type { TemplateDetail } from "@/lib/templates/card";
import type { TemplateContents } from "@/lib/templates/opened";
import { formatCount } from "../api";
import type { LayerRenderData } from "../builder/render-data";
import { useHeaderReach } from "../shell/use-header-reach";
import { ErrorNote } from "../ui/ErrorNote";
import { ChevronIcon, TemplateIcon } from "../ui/icons";
import { GeometryGlyph } from "../ui/operation-icons";
import { WorkflowThumb } from "../WorkflowThumb";
import { dataDateLabel, graphSteps } from "./template-model";
import { dataRows, stepTitle, styleWords } from "./template-view-model";
import styles from "./TemplateView.module.css";

/**
 * How it's made: where the builder's inspector stands, the template's own
 * story beside its map or canvas, read in any order, each section folding
 * open or shut. The question and the data start open. The data says, per
 * dataset, where it came from, its licence, its credit and its date; a
 * workflow example's steps draw as the Workflows page draws a graph; each
 * layer shows its SQL and its style; the styling choices are the
 * template's own words. Nothing in it edits.
 */

/** Why the template map's layers could not be read, with a retry. */
export interface LayersFailure {
  message: string;
  onRetry: () => void;
  /** True when the stage beside the panel already announces this failure:
   * the panel's note then mirrors it without announcing it twice. */
  mirrored?: boolean;
}

export function HowItsMade({
  template,
  opened,
  layers,
  layersFailure = null,
  renders = {},
  groupOf,
  labelOf,
  beside,
}: {
  template: TemplateDetail;
  opened: TemplateContents;
  /** The template map's layers once read; null while they are, or when
   * the read failed. */
  layers: Layer[] | null;
  /** Why the layers' read failed, with its retry; null unless it did. */
  layersFailure?: LayersFailure | null;
  renders?: Record<string, LayerRenderData | undefined>;
  /** Operation id to its catalog group, for a node's hue. */
  groupOf: (operation: string) => string | null;
  /** Operation id to its name; null until the catalog is read. */
  labelOf: ((operation: string) => string) | null;
  /** What the panel stands beside: the map, or a workflow example's canvas
   * (where it holds the pane's place). */
  beside: "map" | "canvas";
}) {
  const ref = useRef<HTMLElement>(null);
  // The header card reaches the panel's right edge, as it reaches the
  // builder's inspector.
  useHeaderReach(() => ref.current);
  const rows = dataRows(template, opened);
  const date = dataDateLabel(template.dataDate);
  const steps = template.steps;
  return (
    <aside
      ref={ref}
      className={styles.panel}
      aria-label="How it's made"
      data-template-panel
      data-beside={beside}
      data-canvas-pane={beside === "canvas" || undefined}
    >
      <header className={styles.panelHead}>
        <span className={styles.eyebrow}>
          <TemplateIcon />
          Template · read only
        </span>
        <h2>How it&apos;s made</h2>
      </header>
      <div className={styles.panelBody}>
        <Fold name="question" title="The question" open>
          <p className={styles.about}>{template.howMade.question}</p>
        </Fold>
        <Fold name="data" title="Data" count={rows.length} open>
          {rows.map((row) => (
            <div key={row.dataset} className={styles.dataRow} data-dataset={row.dataset}>
              <div className={styles.dataTop}>
                <span className={styles.kindTile} aria-hidden>
                  <GeometryGlyph geometryType={row.geometryColumn === null ? null : row.geometryType} />
                </span>
                <b>{row.dataset}</b>
              </div>
              <p className={styles.dataHow}>
                {row.made}
                {row.rowCount === null ? null : ` · ${formatCount(row.rowCount)} rows`}
              </p>
              <dl className={styles.facts}>
                <dt>Source</dt>
                <dd data-fact="source">{row.source?.name ?? "not named"}</dd>
                <dt>Licence</dt>
                <dd data-fact="licence">{row.source?.licence ?? "not named"}</dd>
                <dt>Credit</dt>
                <dd data-fact="credit">{row.source?.credit ?? "not named"}</dd>
                <dt>Data of</dt>
                <dd data-fact="date">{date}</dd>
              </dl>
            </div>
          ))}
        </Fold>
        {steps ? (
          <Fold name="workflow" title="Workflow" count={steps.length}>
            <div className={styles.mini} aria-hidden>
              <WorkflowThumb steps={graphSteps(steps)} groupOf={groupOf} />
            </div>
            <ol className={styles.steps}>
              {steps.map((step, i) => (
                <li key={step.id} data-step={step.id}>
                  <b>{stepTitle(i, step.operation, labelOf)}</b>
                  <code>→ {step.output}</code>
                </li>
              ))}
            </ol>
          </Fold>
        ) : null}
        <Fold name="layers" title="Layers and their SQL" count={layers?.length ?? null}>
          {layers === null ? (
            layersFailure ? (
              <ErrorNote message={layersFailure.message} onRetry={layersFailure.onRetry} announce={!layersFailure.mirrored} />
            ) : (
              <p className={styles.quiet}>Reading the layers…</p>
            )
          ) : (
            layers.map((layer) => {
              const render = renders[layer.id];
              const { colors } = layerSwatch(layer.style, layer.viz, render);
              const count = layerCount(layer.viz, render);
              return (
                <div key={layer.id} className={styles.layer} data-layer={layer.id}>
                  <div className={styles.layerHead}>
                    <span className={styles.swatch} aria-hidden>
                      {colors.map((c, i) => (
                        <i key={i} style={{ background: c }} />
                      ))}
                    </span>
                    <b>{layer.name}</b>
                    <small>
                      {layerKind(layer.viz, render)}
                      {count ? ` · ${count}` : null}
                    </small>
                  </div>
                  <pre className={styles.sql} data-layer-sql>{layer.sql}</pre>
                  <p className={styles.styleLine} data-layer-style>{styleWords(layer)}</p>
                </div>
              );
            })
          )}
        </Fold>
        <Fold name="styling" title="Styling choices">
          <ul className={styles.choices}>
            {template.howMade.styling.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Fold>
      </div>
    </aside>
  );
}

/** One foldable section: its title the toggle, a chevron for its state. */
function Fold({
  name,
  title,
  count = null,
  open: initiallyOpen = false,
  children,
}: {
  name: string;
  title: string;
  count?: number | null;
  open?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section className={styles.fold} data-fold={name}>
      <button
        type="button"
        className={styles.foldHead}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{title}</span>
        {count === null ? null : <span className={styles.count}>{count}</span>}
        <span className={styles.chevron} data-open={open || undefined}>
          <ChevronIcon />
        </span>
      </button>
      {open ? <div className={styles.foldBody}>{children}</div> : null}
    </section>
  );
}
