import type { DocumentExpectation, DocumentKey } from "../metadata/revisions";
import { captureBasis } from "../../../scripts/revision-fixtures.mjs";

/** The service fixture caller supplies the read. Capture before racing the
 * other writer; never hide a new store read in a mutation helper. */
export function capturedExpectation(document: DocumentKey, value: unknown): DocumentExpectation {
  return { ...document, expectedRevision: captureBasis(value).editRevision };
}
