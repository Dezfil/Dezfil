/**
 * What a service's Test answers, in a closed shape: a pass with the time the
 * service took (Overture: how many releases it lists and the newest; the
 * template catalogue: how many templates its index lists, with the time), or
 * one failure reason from a closed list. Never a body, an address or a key.
 */

/** The services a Test reaches: the address finder, travel time,
 * OpenStreetMap's Overpass server, the Overture release listing, the S3
 * address, the satellite imagery's tile template and the template
 * catalogue's index. */
export const TESTED_SERVICES = ["geocode", "isochrone", "overpass", "overture", "s3", "satellite", "templates"] as const;
export type TestedService = typeof TESTED_SERVICES[number];

/** Why a Test failed: no address; the egress rules refused it (with the
 * check's sentence); nothing answered; no answer within the time limit; an
 * answer with a status (and its number); an answer, but not as the service
 * gives one. */
export const TEST_FAILURES = ["not_set_up", "refused", "unreachable", "timed_out", "status", "unexpected_answer"] as const;
export type TestFailure = typeof TEST_FAILURES[number];

export type ServiceTestAnswer =
  | { service: Exclude<TestedService, "overture" | "templates">; result: "passed"; milliseconds: number }
  | { service: "overture"; result: "passed"; releases: number; newest: string }
  | { service: "templates"; result: "passed"; templates: number; milliseconds: number }
  | { service: TestedService; result: "failed"; reason: "refused"; message: string }
  | { service: TestedService; result: "failed"; reason: "status"; status: number }
  | { service: TestedService; result: "failed"; reason: Exclude<TestFailure, "refused" | "status"> };

export function isTestedService(value: unknown): value is TestedService {
  return typeof value === "string" && (TESTED_SERVICES as readonly string[]).includes(value);
}
