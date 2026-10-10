"use client";
import { useState } from "react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { BasemapsCard } from "./BasemapsCard";
import { useInstanceRead, type InstanceRead } from "./instance-read";
import { PalettesCard } from "./PalettesCard";
import { SatelliteCard } from "./SatelliteCard";
import { useDrawn } from "./settings-land";
import cardStyles from "./SettingsCard.module.css";

/** Libraries: what the instance offers every map, as the configuration
 * read reports it. The basemaps a person may choose and whether a map may
 * take a style address of its own, the satellite imagery's tile address
 * and credit, and the palettes people saved. Each card keeps its own
 * values; a write's response is what the cards show next, so the imagery
 * saved or removed shows Satellite in Basemaps or takes it away. */
export function LibrariesTab() {
  const { read, error, retry } = useInstanceRead();
  const [answered, setAnswered] = useState<InstanceRead | null>(null);
  useDrawn(!!read);
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  const now = answered ?? read;
  return <>
    <BasemapsCard read={read} now={now} onAnswer={setAnswered} />
    <SatelliteCard read={read} now={now} onAnswer={setAnswered} />
    <PalettesCard />
  </>;
}
