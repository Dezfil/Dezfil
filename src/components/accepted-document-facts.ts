import type { LastChange } from "./sharing/LastChanged";

/** Child successes carry their parent document's facts on the envelope. */
export function acceptedDocumentFacts(value: unknown): LastChange & { editRevision?: string } {
  if (!value || typeof value !== "object") return {};
  const body = value as LastChange & { editRevision?: string };
  return {
    ...(typeof body.editRevision === "string" ? { editRevision: body.editRevision } : {}),
    ...(Object.hasOwn(body, "lastChangedAt") ? { lastChangedAt: body.lastChangedAt } : {}),
    ...(Object.hasOwn(body, "lastChangedBy") ? { lastChangedBy: body.lastChangedBy } : {}),
  };
}
