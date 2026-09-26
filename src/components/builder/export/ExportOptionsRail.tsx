"use client";

import { useId } from "react";
import type { MapWidget } from "@/lib/widgets";
import {
  BASEMAP_LAYER_GROUPS,
  BASEMAP_LAYER_GROUP_LABELS,
  basemapLayersApply,
  type BasemapLayers,
} from "@/lib/basemap-layers";
import type { BasemapKind } from "@/lib/basemap";
import type { Corner } from "@/lib/corners";
import {
  EXPORT_MAX_DIMENSION,
  EXPORT_WIDTH_PRESETS,
  SIZE_STEPS,
  type ExportImageDefinition,
  type SizeStep,
} from "@/lib/export/image-definition";
import { ChoiceGroup } from "../../ui/ChoiceGroup";
import { CornerPicker } from "../../ui/CornerPicker";
import { SwitchRow } from "../../ui/Switch";
import { ASPECT_PRESETS, type AspectKey } from "./aspect";
import styles from "./ExportImageCard.module.css";

/**
 * The export card's options rail: every control the card offers,
 * extracted from the card as the decomposition rule's at-touch slice —
 * the card kept the preview, the download and the state, and this file
 * took the controls it was growing.
 *
 * The rail edits the definition and one card-level choice (which
 * map-size step is selected); it owns no state of its own.
 */

const STEP_CHOICES = SIZE_STEPS.map((s) => ({
  value: s,
  label: s.toUpperCase(),
}));

export function ExportOptionsRail({
  def,
  setDef,
  aspect,
  onAspect,
  onWidth,
  onLegendCorner,
  aspectLabel,
  mapStep,
  onMapStep,
  mapStepReasons,
  legendPresent,
  widgets,
  basemapKind,
}: {
  def: ExportImageDefinition;
  setDef: (next: (d: ExportImageDefinition) => ExportImageDefinition) => void;
  aspect: AspectKey | "custom";
  onAspect: (key: AspectKey | "custom") => void;
  /** The card owns the size, so it can keep the composition on whole
   * pixels rather than letting each control round. */
  onWidth: (width: number) => void;
  /** The card owns the no-overlap rule, because every corner change must
   * pass through it — the control, the drag, and the seed alike. */
  onLegendCorner: (
    d: ExportImageDefinition,
    corner: Corner,
  ) => ExportImageDefinition;
  /** What the current shape is called — a preset's name, or the custom
   * ratio the drag produced. */
  aspectLabel: string;
  mapStep: SizeStep;
  onMapStep: (step: SizeStep) => void;
  /** Why a step cannot be picked right now, per step; absent means it
   * can. The control disables with the reason rather than failing at
   * download — the treatment the over-tall size preset already gets. */
  mapStepReasons: Partial<Record<SizeStep, string>>;
  legendPresent: boolean;
  widgets: MapWidget[];
  basemapKind: BasemapKind;
}) {
  const groupsApply = basemapLayersApply(basemapKind);
  const basemapLayers: BasemapLayers = def.basemapLayers ?? {};
  const creditCorner = def.credit?.corner ?? "bottom-right";
  const creditSize = def.credit?.size ?? "m";
  const widgetsHeadingId = useId();
  const basemapHeadingId = useId();

  return (
    <>
      <section className={styles.sec}>
        <h5>Shape</h5>
        {/* Four proportion cards, Custom a peer of the presets — each drawn as a small
            rectangle of its own shape, so the choice is visible before
            it is read. */}
        <ChoiceGroup
          label="Aspect ratio"
          value={aspect}
          onChange={onAspect}
          className={styles.shapeGrid}
          itemClassName={styles.shapeCard}
          choices={[
            ...ASPECT_PRESETS.map((p) => ({
              value: p.key as AspectKey | "custom",
              name: p.label,
              label: (
                <>
                  <span
                    className={styles.shapeMini}
                    style={{
                      width: p.ratio >= 1 ? 30 : 30 * p.ratio,
                      height: p.ratio >= 1 ? 30 / p.ratio : 30,
                    }}
                    aria-hidden
                  />
                  <span className={styles.shapeName}>{p.label}</span>
                </>
              ),
            })),
            {
              value: "custom" as AspectKey | "custom",
              name: "Custom",
              label: (
                <>
                  <span
                    className={`${styles.shapeMini} ${styles.shapeMiniCustom}`}
                    style={{ width: 30, height: 22 }}
                    aria-hidden
                  />
                  {/* Always the word — with the ratio equal to a preset
                      the derived label IS that preset's name, and two
                      cards reading "4:3" is exactly the confusion Custom
                      exists to end. The ratio lives in
                      the hint. */}
                  <span className={styles.shapeName}>Custom</span>
                </>
              ),
            },
          ]}
        />
        <p className={styles.hint} data-shape-label="">
          {aspect === "custom"
            ? `${aspectLabel} · drag the preview's bottom or right edge`
            : aspectLabel}
        </p>
      </section>

      <section className={styles.sec}>
        <h5>Size</h5>
        <div className={styles.chips}>
          {EXPORT_WIDTH_PRESETS.map((w) => {
            const tall =
              Math.round(w * (def.size.height / def.size.width)) >
              EXPORT_MAX_DIMENSION;
            return (
              <button
                key={w}
                type="button"
                className={styles.chip}
                aria-pressed={def.size.width === w}
                disabled={tall}
                data-hint={
                  tall
                    ? `Too tall at this shape (over ${EXPORT_MAX_DIMENSION}px)`
                    : undefined
                }
                data-hint-always={tall ? "" : undefined}
                aria-describedby={tall ? `width-reason-${w}` : undefined}
                onClick={() => onWidth(w)}
              >
                <b>{w}</b>
                <span className={styles.chipSub}>px wide</span>
                {tall && (
                  <span id={`width-reason-${w}`} hidden>
                    Too tall at this shape (over {EXPORT_MAX_DIMENSION}px)
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Title sits right under Size (field round): the
          image's own words before the overlays that decorate it. */}
      <section className={styles.sec}>
        <h5>Title</h5>
        <input
          className={styles.titleInput}
          type="text"
          maxLength={200}
          placeholder="No title"
          aria-label="Image title"
          value={def.title?.text ?? ""}
          onChange={(e) => {
            const text = e.target.value;
            setDef((d) => ({
              ...d,
              // A title typed into a fresh card starts at S, like every
              // other element's opening step (field round).
              title: text ? { text, size: d.title?.size ?? "s" } : null,
            }));
          }}
        />
        {def.title && (
          <div className={styles.subControl}>
            <ChoiceGroup
              label="Title size"
              value={def.title.size}
              onChange={(size: SizeStep) =>
                setDef((d) => ({
                  ...d,
                  title: d.title ? { ...d.title, size } : d.title,
                }))
              }
              className={styles.seg}
              itemClassName={styles.segItem}
              choices={STEP_CHOICES}
            />
          </div>
        )}
      </section>

      <section className={styles.sec}>
        <h5>Legend</h5>
        <SwitchRow
          className={styles.switchRow}
          checked={def.legend.visible}
          disabled={!legendPresent}
          onChange={(e) =>
            // Through the same invariant as a drag: hiding the legend,
            // moving the credit into its corner and re-enabling it
            // would otherwise stack both there and obscure a required
            // attribution.
            setDef((d) =>
              e.target.checked
                ? onLegendCorner(
                    { ...d, legend: { ...d.legend, visible: true } },
                    d.legend.corner,
                  )
                : { ...d, legend: { ...d.legend, visible: false } },
            )
          }
          label="Include the legend"
        />
        {!legendPresent ? (
          <p className={styles.hint}>No layer contributes a legend.</p>
        ) : (
          <div
            className={styles.subControl}
            data-off={!def.legend.visible || undefined}
          >
            <ChoiceGroup
              label="Legend size"
              value={def.legend.size}
              onChange={(size: SizeStep) =>
                setDef((d) => ({ ...d, legend: { ...d.legend, size } }))
              }
              className={styles.seg}
              itemClassName={styles.segItem}
              choices={STEP_CHOICES}
            />
            {/* The legend sits where the builder's Legend tab put it —
                the in-preview drag retired. */}
          </div>
        )}
      </section>

      {widgets.length > 0 && (
        <section
          className={styles.sec}
          role="group"
          aria-labelledby={widgetsHeadingId}
        >
          <h5 id={widgetsHeadingId}>Widgets</h5>
          {/* The kit switch, the ruled exception to the pick-many
              checkbox rule — this list only. Toggling
              includes or excludes the widget from this image; the
              map's own visibility never moves. */}
          {widgets.map((w) => (
            <SwitchRow
              key={w.id}
              className={styles.switchRow}
              checked={def.widgets.includes(w.id)}
              onChange={(e) =>
                setDef((d) => ({
                  ...d,
                  widgets: e.target.checked
                    ? widgets
                        .map((x) => x.id)
                        .filter((id) => id === w.id || d.widgets.includes(id))
                    : d.widgets.filter((id) => id !== w.id),
                }))
              }
              label={w.title || "Untitled widget"}
            />
          ))}
          <div
            className={styles.subControl}
            data-off={def.widgets.length === 0 || undefined}
          >
            <ChoiceGroup
              label="Widget size"
              value={def.widgetSize ?? "m"}
              disabled={def.widgets.length === 0}
              onChange={(widgetSize: SizeStep) =>
                setDef((d) => ({ ...d, widgetSize }))
              }
              className={styles.seg}
              itemClassName={styles.segItem}
              choices={STEP_CHOICES}
            />
          </div>
        </section>
      )}

      <section
        className={styles.sec}
        role="group"
        aria-labelledby={basemapHeadingId}
      >
        <h5 id={basemapHeadingId}>Basemap</h5>
        {/* The map-size step lives with the thing it changes (field
            round, directive 3): it scales the basemap's labels, roads
            and detail, and nothing of the author's own data. */}
        <ChoiceGroup
          label="Basemap label and symbol size"
          value={mapStep}
          onChange={onMapStep}
          className={styles.seg}
          itemClassName={styles.segItem}
          choices={STEP_CHOICES.map((c) => ({
            ...c,
            disabled: Boolean(mapStepReasons[c.value]),
            title: mapStepReasons[c.value],
          }))}
        />
        {mapStepReasons[mapStep] ? (
          <p className={styles.hint}>{mapStepReasons[mapStep]}</p>
        ) : null}
        {!groupsApply ? (
          <p className={styles.hint}>Imagery basemap: no layers.</p>
        ) : (
          <div className={styles.subControl}>
            {BASEMAP_LAYER_GROUPS.map((group) => (
              <label key={group} className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={basemapLayers[group] !== false}
                  onChange={(e) =>
                    setDef((d) => ({
                      ...d,
                      basemapLayers: {
                        ...(d.basemapLayers ?? {}),
                        [group]: e.target.checked,
                      },
                    }))
                  }
                />
                {BASEMAP_LAYER_GROUP_LABELS[group]}
              </label>
            ))}
          </div>
        )}
      </section>

      <section className={styles.sec}>
        <h5>Credit</h5>
        <ChoiceGroup
          label="Credit size"
          value={creditSize}
          onChange={(size: SizeStep) =>
            setDef((d) => ({
              ...d,
              credit: { corner: d.credit?.corner ?? "bottom-right", size },
            }))
          }
          className={styles.seg}
          itemClassName={styles.segItem}
          choices={STEP_CHOICES}
        />
        <div className={styles.subControl}>
          <CornerPicker
            label="Credit corner"
            value={creditCorner}
            onChange={(corner: Corner) =>
              setDef((d) => ({
                ...d,
                credit: { corner, size: d.credit?.size ?? "m" },
              }))
            }
            // The legend's corner is not offered: two stacked overlays
            // in one corner is not a placement, it is a collision.
            disabledCorners={
              def.legend.visible && legendPresent
                ? { [def.legend.corner]: "The legend is in this corner" }
                : undefined
            }
          />
        </div>
      </section>
    </>
  );
}
