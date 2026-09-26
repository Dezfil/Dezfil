import { geocoderConfigured } from "@/lib/geocode/endpoint";
import { isochroneConfigured } from "@/lib/isochrone/endpoint";
import type { Availability, Capability, OperationDef } from "./catalog";

/**
 * What this instance can do, answered once and served with the catalog.
 *
 * **Separate from the catalog on purpose, in both directions.** The catalog is
 * a description a client bundle reads, so it may not reach for server-only
 * configuration; and availability is a fact about a deployment rather than
 * about a verb, so declaring it beside the verb would be a lie the moment an
 * administrator changed a setting.
 *
 * Nothing here knows any verb. A verb declares what it *requires*, this answers
 * whether the instance has it, and the picker reads the answer — which is what
 * makes a later capability one entry in this table rather than a change in
 * three places.
 */

const CAPABILITIES: Record<
  Capability,
  { present: () => boolean; missing: string }
> = {
  geocoder: {
    present: geocoderConfigured,
    missing: "Needs a geocoding endpoint. Set DEZFIL_GEOCODER_URL.",
  },
  isochrone: {
    present: isochroneConfigured,
    missing: "Needs a routing endpoint. Set DEZFIL_ISOCHRONE_URL.",
  },
};

export function availabilityOf(operation: OperationDef): Availability {
  const missing = (operation.requires ?? []).filter(
    (capability) => !CAPABILITIES[capability]?.present(),
  );
  if (missing.length === 0) return { available: true, reason: null };
  return {
    available: false,
    // The first missing one, in the verb's own declared order: a reader needs
    // one sentence they can act on, not a list of everything absent.
    reason: CAPABILITIES[missing[0]].missing,
  };
}

/** The catalog as it is served: every verb carrying whether this instance can
 * run it. A verb with no requirement carries an available answer rather than
 * nothing, so a reader never has to know which verbs have requirements. */
export function withAvailability(operations: OperationDef[]): OperationDef[] {
  return operations.map((operation) => ({
    ...operation,
    availability: availabilityOf(operation),
  }));
}
