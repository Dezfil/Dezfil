import type { DocumentExpectation, DocumentKey } from "../metadata/revisions";
import { captureBasis } from "../../../scripts/revision-fixtures.mjs";

/** The service fixture caller supplies the read. Capture before racing the
 * other writer; never hide a new store read in a mutation helper. */
export function capturedExpectation(document: DocumentKey, value: unknown): DocumentExpectation {
  return { ...document, expectedRevision: captureBasis(value).editRevision };
}

/** Passive request adapter. The fixture caller owns the captured read. */
export function withFixtureRevision(request: Request, revision: string | null | undefined): Request {
  if (revision) request.headers.set("X-Edit-Revision", revision);
  return request;
}
