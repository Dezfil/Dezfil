import { memberDocuments } from "../metadata/filing-recording";
import { readDocumentRevision } from "../metadata/revisions";
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

/** A fixture's explicit read of the documents named by a filing intent.
 * Capture this separately before a race; the transport never calls it. */
export function readFilingRevisions(change: import("../metadata/projects").MemberChange, db?: import("better-sqlite3").Database): Record<string, string> {
  return Object.fromEntries(memberDocuments(change).flatMap(document => {
    const revision = readDocumentRevision(document, db)?.editRevision;
    return revision ? [[`${document.kind}:${document.id}`, revision]] : [];
  }));
}
