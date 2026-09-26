"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../AssistantPanel.module.css";

/**
 * The pane's one status region (the region that carried the card's words). Its sentences come from
 * the conversation's announcement list, which the turn hook fills from the event sequence and the
 * receipt (turn-announcements.ts), never from a rendered snapshot's diff, so a call and its result
 * arriving in one chunk still sound both. The region holds the sentences added since it last spoke,
 * joined when one render carries several; a new turn's list starts over.
 */
export function TurnAnnouncements({ announcements }: { announcements: string[] }) {
  const spoken = useRef(0);
  const [words, setWords] = useState("");
  useEffect(() => {
    if (announcements.length < spoken.current) spoken.current = 0;
    if (announcements.length > spoken.current) {
      setWords(announcements.slice(spoken.current).join(" "));
      spoken.current = announcements.length;
    }
  }, [announcements]);
  return <p className={styles.srOnly} role="status" data-turn-status>{words}</p>;
}
