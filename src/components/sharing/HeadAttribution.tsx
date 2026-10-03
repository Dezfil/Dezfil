"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LastChanged, type LastChange } from "./LastChanged";

const subscribeNever = () => () => {};

/** Attribution stands after the start actions (the builder's search), outside
 * the capped path card, so it never enlarges the card's name budget. */
export function HeadAttribution({ value }: { value: LastChange }) {
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const slot = mounted ? document.getElementById("header-attribution-slot") : null;
  return slot ? createPortal(<LastChanged value={value} head />, slot) : null;
}
