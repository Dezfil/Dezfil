"use client";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { DefaultsCardView, DefaultsChoiceRow, useDefaultsUnit } from "./defaults-card";
import { DEFAULTS_TABS } from "./defaults-table";
import { useInstanceRead, type InstanceRead } from "./instance-read";
import { useDrawn } from "./settings-land";
import cardStyles from "./SettingsCard.module.css";

const [IMAGE_EXPORT] = DEFAULTS_TABS.publishing;

/** Publishing: where a fresh image export card starts, its width and its
 * shape, as the configuration read reports them, each kept as it is
 * chosen. A card already open keeps what it opened with. */
export function PublishingTab() {
  const { read, error, retry } = useInstanceRead();
  useDrawn(!!read);
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  return <ImageExportCard settings={read.settings} />;
}

function ImageExportCard({ settings }: { settings: InstanceRead["settings"] }) {
  const [unit, snapshot] = useDefaultsUnit(IMAGE_EXPORT, settings);
  return <DefaultsCardView card={IMAGE_EXPORT} unit={unit} snapshot={snapshot}>
    {IMAGE_EXPORT.rows.map(row => <DefaultsChoiceRow key={row.id} row={row} setting={settings[row.fields[0].key]} unit={unit} snapshot={snapshot} />)}
  </DefaultsCardView>;
}
