"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LastChanged, type LastChange } from "./LastChanged";

const subscribeNever = () => () => {};

/** Attribution follows the capped path card without enlarging its name budget. */
export function HeadAttribution({ value }: { value: LastChange }) {
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const slot = mounted ? document.getElementById("header-attribution-slot") : null;
  return slot ? createPortal(<LastChanged value={value} head />, slot) : null;
}
