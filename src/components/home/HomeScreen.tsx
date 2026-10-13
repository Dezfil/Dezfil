"use client";

import { useMemo } from "react";
import { useSignedInLabel } from "../sharing/signed-in";
import { homeView } from "./home-model";
import { useHomeReads } from "./home-reads";
import styles from "./Home.module.css";

/**
 * Home: the signed-in person's own page, read as them and stored nowhere.
 * Every part comes from Home's model over the reads' answers, so the page
 * shows what an agent calling the same reads would work out.
 */
export function HomeScreen() {
  const label = useSignedInLabel();
  const { reads } = useHomeReads();
  const view = useMemo(
    () => homeView(reads, { name: label?.name ?? null, sqlName: label?.sqlName ?? null }),
    [reads, label],
  );

  return (
    <div className={styles.screen} data-home>
      <h1 className={styles.welcome} data-welcome>
        {view.welcome}
      </h1>
    </div>
  );
}
