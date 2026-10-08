"use client";

import { useEffect, useState } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import { readOperations } from "../../api";

/**
 * What the places line says when the instance has no address finder.
 *
 * Who can change that, and how, is a fact about the instance now: an admin's
 * setting while no variable locks it, the variable and a restart while one
 * does. The server words it once, in the availability it serves with each
 * verb of the operations read, and the line takes it from there rather than
 * keeping a sentence of its own that could say the wrong thing.
 */

const MISSING = "Place search needs a geocoding endpoint.";

/** The line, from the served operations; without them, what is missing alone. */
export function placesUnconfiguredLine(operations: OperationDef[] | null): string {
  // A verb whose first need is the address finder carries that need's reason:
  // its first sentence says what is missing, the rest who can change it.
  const reason = operations?.find(
    operation => operation.requires?.[0] === "geocoder" && operation.availability?.available === false,
  )?.availability?.reason;
  const remedy = reason?.replace(/^[^.]*\.\s*/, "").trim();
  return remedy ? `${MISSING} ${remedy}` : MISSING;
}

/** The line while `shown`, read afresh each time it is shown. */
export function usePlacesUnconfiguredLine(shown: boolean): string {
  const [operations, setOperations] = useState<OperationDef[] | null>(null);
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    void readOperations().then(
      read => { if (!cancelled) setOperations(read); },
      () => { if (!cancelled) setOperations(null); },
    );
    return () => { cancelled = true; };
  }, [shown]);
  return placesUnconfiguredLine(shown ? operations : null);
}
