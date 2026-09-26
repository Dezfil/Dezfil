"use client";

import { useEffect, useRef, useState } from "react";
import type { GeometryFormat } from "@/lib/geometry-evidence";
import { Select, TextInput } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { CaretIcon, FormatH3Icon, FormatJsonIcon, FormatPairIcon, FormatWkbIcon, FormatWktIcon, InfoIcon, SwapIcon } from "../ui/icons";
import { acceptedColumns } from "./columns";
import { AMBIGUOUS_PAIR, countSentence, pairHint as ambiguousPair, panelNotice } from "./derivations";
import { FORMAT_ORDER } from "./opening-choice";
import type { PanelController, PanelState } from "./panel-controller";
import { CURATED_PROJECTIONS, projectionFieldValue, takesProjection } from "./projection";
import styles from "./SetGeometryPanel.module.css";

/** The drawn format list: label and the example beside it. Each
 * button's accessible name is its label alone; the example stays visible. */
const FORMATS: Record<GeometryFormat, { label: string; example: string; Icon: () => React.JSX.Element }> = {
  pair: { label: "Coordinate pair", example: "two number columns", Icon: FormatPairIcon },
  wkt: { label: "WKT text", example: "POINT(…), LINESTRING(…)", Icon: FormatWktIcon },
  geojson: { label: "GeoJSON", example: '{"type": …}', Icon: FormatJsonIcon },
  wkb: { label: "WKB hex", example: "0101000020…", Icon: FormatWkbIcon },
  h3: { label: "H3 cell", example: "881f1d4899fffff", Icon: FormatH3Icon },
};

function ColumnSelect({ value, options, onChange, label }: {
  value: string;
  options: { name: string; type: string }[];
  onChange: (name: string) => void;
  label: string;
}) {
  return (
    <span className={styles.select}>
      <Select className={styles.mono} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        {options.map((c) => (
          <option key={c.name} value={c.name}>{c.name} · {c.type}</option>
        ))}
      </Select>
      <CaretIcon />
    </span>
  );
}

/** The Other EPSG code field (03 C): committed as it settles, and on Enter
 * or blur, so a typed code asks for one preview rather than one a digit. */
function OtherCodeField({ text, onCommit }: { text: string; onCommit: (text: string) => void }) {
  const [local, setLocal] = useState(text);
  const timer = useRef<number | null>(null);
  const latest = useRef(onCommit);
  useEffect(() => {
    latest.current = onCommit;
  }, [onCommit]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const commit = (value: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (value !== text) latest.current(value);
  };
  return (
    <TextInput
      className={styles.mono}
      value={local}
      placeholder="EPSG code, for example 31467"
      aria-label="EPSG code"
      inputMode="numeric"
      onChange={(e) => {
        const value = e.target.value;
        setLocal(value);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => commit(value), 350);
      }}
      onBlur={() => commit(local)}
      onKeyDown={(e) => { if (e.key === "Enter") commit(local); }}
    />
  );
}

/**
 * The set-geometry controls (03 P and C): the format, the column or the
 * pair with its swap, the projection with its Other code entry, the
 * notice, the hint and the count sentence, in the drawn order. They take
 * their data and callbacks from the panel's state and know nothing of the
 * page, so Add data's column matching can reuse them. That surface draws
 * no map, so it asks through `pairHint` to omit the one hint that names
 * the map; the dataset panel's default shows it as merged.
 */
export function SetGeometryControls({ state, controller, pairHint = true }: { state: PanelState; controller: PanelController; pairHint?: boolean }) {
  const { inspection, choice, marked, preview } = state;
  if (inspection === null) return null;
  const native = inspection.geometryColumn !== null && choice.columns.includes(inspection.geometryColumn);
  const options = acceptedColumns(choice.format, inspection.columns, inspection.geometryColumn, native);
  const notice = panelNotice(preview.answer);
  const fieldMarked = marked || notice?.kind === "not-degrees";
  const field = projectionFieldValue(choice, inspection.geometryRecord, marked);
  const count = countSentence(preview.answer);
  return (
    <div className={styles.body}>
      <div className={styles.field}>
        <span className={styles.label} id="set-geometry-format">Format</span>
        <div className={styles.formats} role="group" aria-labelledby="set-geometry-format">
          {FORMAT_ORDER.map((format) => {
            const { label, example, Icon } = FORMATS[format];
            return (
              <button key={format} type="button" aria-label={label} aria-pressed={choice.format === format} onClick={() => controller.setFormat(format)}>
                <Icon />
                <span className={styles.formatLabel}>{label}</span>
                <span className={styles.formatExample}>{example}</span>
              </button>
            );
          })}
        </div>
      </div>

      {choice.format === "pair" ? (
        <div className={styles.pair}>
          <label className={styles.field}>
            <span className={styles.pairLabel}>Longitude · x</span>
            <ColumnSelect label="Longitude column" value={choice.columns[0] ?? ""} options={options} onChange={(name) => controller.setColumn(0, name)} />
          </label>
          <IconButton className={styles.swap} action="Swap the two columns" icon={<SwapIcon />} onClick={() => controller.swap()} />
          <label className={styles.field}>
            <span className={styles.pairLabel}>Latitude · y</span>
            <ColumnSelect label="Latitude column" value={choice.columns[1] ?? ""} options={options} onChange={(name) => controller.setColumn(1, name)} />
          </label>
        </div>
      ) : (
        <label className={styles.field}>
          <span className={styles.label}>Column</span>
          <ColumnSelect label="Column" value={choice.columns[0] ?? ""} options={options} onChange={(name) => controller.setColumn(0, name)} />
        </label>
      )}
      {notice && (
        <p className={styles.notice} data-notice={notice.kind} role="status">
          <InfoIcon />
          <span>{notice.text}</span>
        </p>
      )}
      {!notice && pairHint && ambiguousPair(inspection.candidates, choice) && <p className={styles.hint}>{AMBIGUOUS_PAIR}</p>}

      {takesProjection(choice.format) && (
        <div className={styles.field}>
          <label className={styles.field}>
            <span className={styles.label}>Projection <small>the numbers are in</small></span>
            <span className={styles.select}>
              <Select value={field.value} aria-label="Projection" data-attn={fieldMarked || undefined} data-field="projection" onChange={(e) => controller.chooseProjection(e.target.value)}>
                {field.value === "" && <option value="">Choose a projection</option>}
                {CURATED_PROJECTIONS.map((p) => (
                  <option key={p.epsg} value={String(p.epsg)}>{p.name} (EPSG:{p.epsg})</option>
                ))}
                <option value="other">Other EPSG code…</option>
              </Select>
              <CaretIcon />
            </span>
          </label>
          {field.value === "other" && <OtherCodeField text={field.text} onCommit={(text) => controller.typeOtherCode(text)} />}
        </div>
      )}

      {count && (
        <p className={styles.count} data-zero={count.readable === 0 || undefined}>
          {count.readable === 0 ? (
            <span className={styles.bad}><b>0</b> of {count.total} sampled rows can be read.</span>
          ) : (
            <>
              <span><b>{count.readable}</b> of {count.total} sampled rows read as {count.kind}.</span>
              {count.unreadable > 0 && <span className={styles.bad}><b>{count.unreadable}</b> could not be read. They keep no geometry.</span>}
            </>
          )}
        </p>
      )}
    </div>
  );
}
