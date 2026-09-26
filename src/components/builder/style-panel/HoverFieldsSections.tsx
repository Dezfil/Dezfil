"use client";

import type { Layer } from "@/lib/metadata/maps";
import { CollapsibleSection } from "../CollapsibleSection";
import { SwitchRow } from "../../ui/Switch";
import styles from "../StylePanel.module.css";

/**
 * The Tooltip and Pop-up field sections, out of `StylePanel.tsx`. Each
 * section is one Automatic switch — an immediate on/off state — over a
 * pick-many checkbox list of fields: the ruled split exactly. Behaviour
 * is unchanged: automatic means null; explicit lists keep the layer's
 * field order, not click order.
 */

const AUTO_FIELDS = 8;

interface Field {
  name: string;
}

function FieldsSection({
  layerId,
  name,
  label,
  stored,
  fields,
  onChange,
}: {
  layerId: string;
  name: string;
  label: string;
  /** Null = automatic. */
  stored: string[] | null;
  fields: Field[];
  onChange: (next: string[] | null) => void;
}) {
  const auto = stored === null;
  const toggle = (fieldName: string) => {
    if (stored === null) return;
    const current = new Set(stored);
    if (current.has(fieldName)) current.delete(fieldName);
    else current.add(fieldName);
    // Preserve the layer's field order, not click order.
    onChange(fields.map((f) => f.name).filter((n) => current.has(n)));
  };
  return (
    <CollapsibleSection layerId={layerId} name={name} label={label}>
      <SwitchRow
        className={styles.checkRow}
        checked={auto}
        onChange={(e) =>
          onChange(
            e.target.checked
              ? null
              : fields.slice(0, AUTO_FIELDS).map((f) => f.name),
          )
        }
        label="Automatic (first fields)"
      />
      {!auto && (
        <div className={styles.fieldChecks}>
          {fields.map((f) => (
            <label key={f.name} className={styles.checkRow}>
              <input
                type="checkbox"
                checked={stored?.includes(f.name) ?? false}
                onChange={() => toggle(f.name)}
              />
              {f.name}
            </label>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}

export function HoverFieldsSections({
  layer,
  fields,
  onTooltip,
  onPopup,
}: {
  layer: Layer;
  fields: Field[];
  onTooltip: (tooltip: string[] | null) => void;
  onPopup: (popup: string[] | null) => void;
}) {
  return (
    <>
      {/* Tooltip fields — heatmaps aren't hoverable; the host renders
          us only when hoverable. */}
      <FieldsSection
        layerId={layer.id}
        name="tooltip"
        label="Tooltip"
        stored={layer.tooltip}
        fields={fields}
        onChange={onTooltip}
      />
      {/* Pop-up fields — the click card, chosen independently of the
          tooltip. */}
      <FieldsSection
        layerId={layer.id}
        name="popup"
        label="Pop-up"
        stored={layer.popup}
        fields={fields}
        onChange={onPopup}
      />
    </>
  );
}
