import type { Database } from "better-sqlite3";
import type { IncomingHttpHeaders } from "node:http";
import { ApiError } from "@/lib/api/errors";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { configuredEndpoint } from "@/lib/geocode/endpoint";
import { readAnswerBody, requestGeocoder } from "@/lib/geocode/provider";
import { openS3AddressRoot } from "@/lib/ingest/remote";
import { configuredIsochroneEndpoint } from "@/lib/isochrone/endpoint";
import { isNoRouteAnswer, readIsochroneBody, requestIsochrone } from "@/lib/isochrone/provider";
import { metadataDb } from "@/lib/metadata/db";
import { readCapped } from "@/lib/net/read-capped";
import { openOverpass, overpassEndpoint, readOverpassAnswer } from "@/lib/osm/overpass";
import { keepReleaseList, sendReleaseListing } from "@/lib/overture/releases";
import type { ServiceTestAnswer, TestedService } from "./service-test-answer";

/**
 * A service's Test: one fixed request to the service at its address in
 * effect, never a typed one, sent through the service's own request step
 * below its cache, so the way its requests go (the egress check, redirects
 * included, and the gap for the address finder and travel time) and with
 * no cache read or written. It reaches outside this server and stores
 * nothing, except that Overture's Test keeps the release list it finds, as
 * Check now does. A second Test of a service while one runs gets the same
 * answer from the same request.
 *
 * The answer is a closed shape (`service-test-answer.ts`): what the service
 * said is read only to tell a pass from a failure, and none of it, nor the
 * address or a key, is ever part of the answer. It is read by the service's
 * own reader (a geocoding run's, a travel-time run's, an import's), so an
 * answer those would not take is answered, but not as the service does.
 */

/** The address finder's fixed question. */
export const TEST_PLACE = "Paris";
/** Travel time's fixed point, asked on foot for the shortest band. */
export const TEST_POINT = { lon: 2.3522, lat: 48.8566 };
const TEST_BANDS = [1];
/** The smallest Overpass query: it selects nothing and prints it. */
export const TEST_QUERY = "[out:json][timeout:10];out;";
/** Past this a Test's answer is not read further; none needs more. */
const ANSWER_BYTES = 64 * 1024;

const passed = (service: Exclude<TestedService, "overture">, milliseconds: number): ServiceTestAnswer =>
  ({ service, result: "passed", milliseconds });
const answeredWith = (service: TestedService, status: number): ServiceTestAnswer =>
  ({ service, result: "failed", reason: "status", status });
const unexpected = (service: TestedService): ServiceTestAnswer =>
  ({ service, result: "failed", reason: "unexpected_answer" });
const notSetUp = (service: TestedService): ServiceTestAnswer =>
  ({ service, result: "failed", reason: "not_set_up" });

/** A status answered: the body is closed unread. */
function closing(response: { body: { destroy(): void } }, answer: ServiceTestAnswer): ServiceTestAnswer {
  response.body.destroy();
  return answer;
}

/** S3's own shape: its request identity on the answer, or its XML. A
 * healthy store refuses an unsigned request at its root, in that shape. */
const s3Headers = (headers: IncomingHttpHeaders) => typeof headers["x-amz-request-id"] === "string";
const s3Body = (text: string | null) =>
  text !== null && /^\s*(<\?xml[^>]*\?>\s*)?<(Error>[\s\S]*<Code>|ListAllMyBucketsResult[\s>])/.test(text);

const TESTS: Record<TestedService, (deadline: () => ApiError) => Promise<ServiceTestAnswer>> = {
  async geocode(deadline) {
    const endpoint = configuredEndpoint();
    if (!endpoint) return notSetUp("geocode");
    // A person waiting, as at a search: ahead of a batch, after the gap.
    const exchange = await requestGeocoder(endpoint, TEST_PLACE, { priority: "interactive", timeoutError: deadline });
    if (exchange.statusCode !== 200) return answeredWith("geocode", exchange.statusCode);
    return exchange.text !== null && readAnswerBody(exchange.text) !== null ? passed("geocode", exchange.milliseconds) : unexpected("geocode");
  },

  async isochrone(deadline) {
    const endpoint = configuredIsochroneEndpoint();
    if (!endpoint) return notSetUp("isochrone");
    const exchange = await requestIsochrone(endpoint, TEST_POINT, "walking", TEST_BANDS, { timeoutError: deadline });
    // No route from the point, in the protocol's own words, is the service answering.
    if (exchange.statusCode === 400 && isNoRouteAnswer(exchange.text)) return passed("isochrone", exchange.milliseconds);
    if (exchange.statusCode !== 200) return answeredWith("isochrone", exchange.statusCode);
    // A band with no route is the service answering; an answer the run
    // could not read is not.
    const read = exchange.text === null ? null : readIsochroneBody(exchange.text, TEST_POINT, TEST_BANDS);
    return read !== null && read.bands.every(band => band.status !== "unreadable_answer")
      ? passed("isochrone", exchange.milliseconds) : unexpected("isochrone");
  },

  async overpass(deadline) {
    const started = Date.now();
    const response = await openOverpass(overpassEndpoint(), TEST_QUERY, deadline);
    if (response.statusCode < 200 || response.statusCode >= 300) return closing(response, answeredWith("overpass", response.statusCode));
    const text = await readCapped(response.body, ANSWER_BYTES);
    const milliseconds = Date.now() - started;
    return text !== null && readOverpassAnswer(text).kind === "answer" ? passed("overpass", milliseconds) : unexpected("overpass");
  },

  async overture(deadline) {
    const { statusCode, releases } = await sendReleaseListing(deadline);
    if (statusCode !== 200) return answeredWith("overture", statusCode);
    if (releases.length === 0) return unexpected("overture");
    // Kept as the list the pane offers, as Check now keeps it.
    keepReleaseList(releases);
    return { service: "overture", result: "passed", releases: releases.length, newest: releases[0] };
  },

  async s3(deadline) {
    // A store may redirect its root elsewhere; the redirect is its answer.
    let shaped = false;
    const started = Date.now();
    const response = await openS3AddressRoot({ timeoutError: deadline, onRedirect: hop => { shaped ||= s3Headers(hop.headers); } });
    if (response.statusCode >= 500) return closing(response, answeredWith("s3", response.statusCode));
    const text = await readCapped(response.body, ANSWER_BYTES);
    const milliseconds = Date.now() - started;
    return shaped || s3Headers(response.headers) || s3Body(text) ? passed("s3", milliseconds) : unexpected("s3");
  },
};

async function run(service: TestedService): Promise<ServiceTestAnswer> {
  // This Test's own deadline, told apart from every other failure by
  // identity, never by its words.
  const deadline = new ApiError("remote_timeout", "The service did not answer within its time limit.", 504);
  try {
    return await TESTS[service](() => deadline);
  } catch (error) {
    if (error === deadline) return { service, result: "failed", reason: "timed_out" };
    if (error instanceof ApiError && error.code === "egress_blocked") return { service, result: "failed", reason: "refused", message: error.message };
    // A stored address the instance's key no longer opens: the service
    // refuses, and so does its Test, never reaching a default instead.
    if (error instanceof ApiError && error.code === "service_address_unreadable") throw error;
    // Whatever else stopped the exchange (a refused connection, a name that
    // does not resolve, an answer cut short) is said without its words,
    // which may repeat the address.
    return { service, result: "failed", reason: "unreachable" };
  }
}

const key = Symbol.for("dezfil.service-tests");
const host = globalThis as typeof globalThis & { [key]?: Map<TestedService, Promise<ServiceTestAnswer>> };
const running = host[key] ??= new Map();

/** Test one service, the admin rechecked first. A Test of a service already
 * under way is joined, not repeated. */
export async function testService(
  context: AuthContext,
  service: TestedService,
  db: Database = metadataDb(),
  now = Date.now(),
): Promise<ServiceTestAnswer> {
  requireAdmin(context, db, now);
  const current = running.get(service);
  if (current) return current;
  const test: Promise<ServiceTestAnswer> = run(service).finally(() => {
    if (running.get(service) === test) running.delete(service);
  });
  running.set(service, test);
  return test;
}
