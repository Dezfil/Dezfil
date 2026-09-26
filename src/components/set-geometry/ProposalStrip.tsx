"use client";

import type { GeometryCandidate } from "@/lib/geometry-evidence";
import { Button } from "../ui/Button";
import { GeoPinIcon, InfoIcon } from "../ui/icons";
import type { SeedChoice } from "./types";
import styles from "./ProposalStrip.module.css";

/** The strip's subject: the dataset's best candidate, the
 * first in the API's order, when it is a weak pair, and nothing else: a
 * best candidate that is not a pair shows the doors and no strip,
 * whatever weaker pairs sit behind it. */
export function proposedPair(candidates: readonly GeometryCandidate[] | undefined): SeedChoice | null {
  const best = candidates?.find((c) => c.sourceRetained);
  if (!best || best.format !== "pair" || best.strength !== "weak" || best.columns.length !== 2) return null;
  const pair = best;
  const first = pair.orientations?.[0];
  return { format: "pair", columns: first ? [first.lon, first.lat] : [pair.columns[0], pair.columns[1]] };
}

/**
 * The proposal strip under the dataset page's header: the drawn
 * sentence naming the pair, Set geometry opening the panel with that pair
 * filled in, and Not now removing the strip for this visit.
 */
export function ProposalStrip({ pair, onSetGeometry, onNotNow }: {
  pair: SeedChoice;
  onSetGeometry: (seed: SeedChoice) => void;
  onNotNow: () => void;
}) {
  return (
    <div className={styles.strip} role="status" data-proposal-strip="">
      <InfoIcon />
      <span>
        <code>{pair.columns[0]}</code> and <code>{pair.columns[1]}</code> look like coordinates.
      </span>
      <span className={styles.acts}>
        <Button variant="primary" className={styles.door} onClick={() => onSetGeometry(pair)} data-set-geometry-door="strip">
          <GeoPinIcon />
          Set geometry
        </Button>
        <Button variant="quiet" onClick={onNotNow}>Not now</Button>
      </span>
    </div>
  );
}
