"use client";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { DefaultsCardView, DefaultsChoiceRow, useDefaultsUnit } from "./defaults-card";
import { DEFAULTS_TABS } from "./defaults-table";
import { useInstanceRead, type InstanceRead } from "./instance-read";
import { RuleCardView } from "./RuleCard";
import { PUBLIC_LINKS_CARD } from "./security-table";
import { useDrawn } from "./settings-land";
import cardStyles from "./SettingsCard.module.css";

const [IMAGE_EXPORT] = DEFAULTS_TABS.publishing;

/** Publishing: who may publish and which other sites may show a published
 * page (Public links), then where a fresh image export card starts, its
 * width and its shape, as the configuration read reports them, each choice
 * kept as it is made and the listed sites on Save. A card already open
 * keeps what it opened with. */
export function PublishingTab() {
  const { read, error, retry } = useInstanceRead();
  useDrawn(!!read);
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  return <>
    <RuleCardView card={PUBLIC_LINKS_CARD} settings={read.settings} />
    <ImageExportCard settings={read.settings} />
  </>;
}

function ImageExportCard({ settings }: { settings: InstanceRead["settings"] }) {
  const [unit, snapshot] = useDefaultsUnit(IMAGE_EXPORT, settings);
  return <DefaultsCardView card={IMAGE_EXPORT} unit={unit} snapshot={snapshot}>
    {IMAGE_EXPORT.rows.map(row => <DefaultsChoiceRow key={row.id} row={row} setting={settings[row.fields[0].key]} unit={unit} snapshot={snapshot} />)}
  </DefaultsCardView>;
}
