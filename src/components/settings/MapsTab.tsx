"use client";
import { BasemapThumb, type ThumbStyle } from "@/components/map/BasemapThumb";
import { useTheme } from "@/components/theme";
import { CornerPicker } from "@/components/ui/CornerPicker";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Select } from "@/components/ui/Field";
import type { BasemapKey } from "@/lib/basemap";
import { isCorner } from "@/lib/corners";
import { DefaultsCardView, DefaultsNumber, invalid, keptNumber, RowErrors, rowSaved, useDefaultsUnit } from "./defaults-card";
import { choiceValues, choiceWords, DEFAULTS_TABS, offeredBasemaps, startsOn } from "./defaults-table";
import { useInstanceRead, type InstanceRead } from "./instance-read";
import { CycleSwatches, LayerSample } from "./LayerSample";
import { PictureChoice } from "./PictureChoice";
import type { SaveUnit, UnitSnapshot } from "./save-unit";
import { useDrawn } from "./settings-land";
import { SettingRow } from "./SettingRows";
import { SavedMark } from "./SettingsCard";
import { WorldLocator } from "./WorldLocator";
import cardStyles from "./SettingsCard.module.css";
import styles from "./MapsTab.module.css";

type Settings = InstanceRead["settings"];
const [NEW_MAPS, LEGEND, NEW_LAYERS] = DEFAULTS_TABS.maps;

/** Maps: what new maps and new layers start with, as the configuration
 * read reports it. Each value is kept as it changes; the basemap and the
 * New layers sample follow what is kept, and maps already made keep
 * their own. */
export function MapsTab() {
  const { read, error, retry } = useInstanceRead();
  useDrawn(!!read);
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  return <MapsCards settings={read.settings} />;
}

function MapsCards({ settings }: { settings: Settings }) {
  const [mapsUnit, maps] = useDefaultsUnit(NEW_MAPS, settings);
  const [legendUnit, legend] = useDefaultsUnit(LEGEND, settings);
  const [layersUnit, layers] = useDefaultsUnit(NEW_LAYERS, settings);
  const { theme } = useTheme();
  const offered = offeredBasemaps(settings);
  const kept = startsOn(maps.kept["newMap.basemap"], offered);
  const ground: BasemapKey = kept === "auto" ? (theme === "dark" ? "dark" : "light") : kept;
  return <>
    <NewMapsCard unit={mapsUnit} snapshot={maps} settings={settings} offered={offered} />
    <LegendCard unit={legendUnit} snapshot={legend} />
    <NewLayersCard unit={layersUnit} snapshot={layers} settings={settings} ground={ground} />
  </>;
}

interface CardProps { unit: SaveUnit; snapshot: UnitSnapshot }

function NewMapsCard({ unit, snapshot, settings, offered }: CardProps & { settings: Settings; offered: readonly ThumbStyle[] }) {
  const [basemap, view] = NEW_MAPS.rows;
  const kept = (key: string) => keptNumber(snapshot, settings[key], key);
  return <DefaultsCardView card={NEW_MAPS} unit={unit} snapshot={snapshot}>
    <SettingRow id={basemap.id} label={basemap.label} stack mark={rowSaved(basemap, snapshot) ? <SavedMark /> : null}>
      <PictureChoice label={basemap.label} size="s" value={startsOn(snapshot.values["newMap.basemap"], offered)}
        choices={offered.map(style => ({ value: style, label: choiceWords("newMap.basemap", style), picture: <BasemapThumb style={style} fill /> }))}
        onChange={next => unit.choose("newMap.basemap", next)} />
      <RowErrors row={basemap} snapshot={snapshot} />
    </SettingRow>
    <SettingRow id={view.id} label={view.label} stack mark={rowSaved(view, snapshot) ? <SavedMark /> : null}>
      <div className={styles.startingView}>
        <div className={styles.viewFields}>
          {view.fields.map((field, index) => <label key={field.key} className={styles.field}>
            <span>{field.label}</span>
            <DefaultsNumber row={view} index={index} setting={settings[field.key]} unit={unit} snapshot={snapshot} name={field.label ?? view.label} />
          </label>)}
        </div>
        <WorldLocator latitude={kept("newMap.latitude")} longitude={kept("newMap.longitude")} zoom={kept("newMap.zoom")}
          onPick={place => unit.keepTogether({ "newMap.latitude": String(place.latitude), "newMap.longitude": String(place.longitude) })} />
      </div>
      <RowErrors row={view} snapshot={snapshot} />
    </SettingRow>
  </DefaultsCardView>;
}

function LegendCard({ unit, snapshot }: CardProps) {
  const [corner] = LEGEND.rows;
  const shown = snapshot.values["newMap.legendCorner"];
  return <DefaultsCardView card={LEGEND} unit={unit} snapshot={snapshot}>
    <SettingRow id={corner.id} label={corner.label}>
      <span className={styles.corners}>
        <CornerPicker label={corner.label} value={isCorner(shown) ? shown : "bottom-left"} onChange={next => unit.choose("newMap.legendCorner", next)} />
      </span>
      {rowSaved(corner, snapshot) && <SavedMark />}
      <RowErrors row={corner} snapshot={snapshot} />
    </SettingRow>
  </DefaultsCardView>;
}

function NewLayersCard({ unit, snapshot, settings, ground }: CardProps & { settings: Settings; ground: BasemapKey }) {
  const [colors, opacity, width, radius] = NEW_LAYERS.rows;
  const kept = (key: string) => keptNumber(snapshot, settings[key], key);
  const palette = String(snapshot.kept["newLayer.colorCycle"] ?? settings["newLayer.colorCycle"]?.defaultValue);
  const look = {
    basemap: ground, palette, pointOpacity: kept("newLayer.pointOpacity"), lineOpacity: kept("newLayer.lineOpacity"),
    areaOpacity: kept("newLayer.areaOpacity"), lineWidth: kept("newLayer.lineWidth"), pointRadius: kept("newLayer.pointRadius"),
  };
  return <DefaultsCardView card={NEW_LAYERS} unit={unit} snapshot={snapshot} head={<LayerSample look={look} />}>
    <SettingRow id={colors.id} label={colors.label}>
      <Select className={styles.select} aria-label={colors.label} data-unit-key="newLayer.colorCycle" value={String(snapshot.values["newLayer.colorCycle"] ?? "")}
        {...invalid(colors, 0, snapshot)} onChange={event => unit.choose("newLayer.colorCycle", event.target.value)}>
        {choiceValues(settings["newLayer.colorCycle"]).map(value => <option key={value} value={value}>{choiceWords("newLayer.colorCycle", value)}</option>)}
      </Select>
      <CycleSwatches palette={palette} />
      {rowSaved(colors, snapshot) && <SavedMark />}
      <RowErrors row={colors} snapshot={snapshot} />
    </SettingRow>
    <SettingRow id={opacity.id} label={opacity.label}>
      {opacity.fields.map((field, index) => <DefaultsNumber key={field.key} row={opacity} index={index} setting={settings[field.key]}
        unit={unit} snapshot={snapshot} name={`${field.label} ${opacity.label.toLowerCase()}`} prefix={field.label} />)}
      {rowSaved(opacity, snapshot) && <SavedMark />}
      <RowErrors row={opacity} snapshot={snapshot} />
    </SettingRow>
    {[width, radius].map(row => <SettingRow key={row.id} id={row.id} label={row.label}>
      <DefaultsNumber row={row} index={0} setting={settings[row.fields[0].key]} unit={unit} snapshot={snapshot} name={row.label} />
      {rowSaved(row, snapshot) && <SavedMark />}
      <RowErrors row={row} snapshot={snapshot} />
    </SettingRow>)}
  </DefaultsCardView>;
}
