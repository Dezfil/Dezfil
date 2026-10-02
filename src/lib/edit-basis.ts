/** A basis travels with the state displayed or accepted by the caller.
 * Transport never obtains one by rereading an already formed payload. */
export interface EditBasis { editRevision: string | null }
export const EDIT_REVISION_HEADER = "X-Edit-Revision";

export function editHeaders(basis: EditBasis, initial?: HeadersInit): Headers {
  if (!basis.editRevision) throw new Error("Read this item before editing it.");
  const headers = new Headers(initial);
  headers.set(EDIT_REVISION_HEADER, basis.editRevision);
  return headers;
}

/** Preparatory callers may hold a basis before an operation declares its
 * request precondition. Never send an unknown tool property. External callers
 * keep ownership of their explicit arguments; this helper performs no I/O. */
export function declaredRevisionArguments(
  tool: { headerParams?: { name: string; argument: string }[] },
  args: Record<string, unknown>,
  basis: EditBasis,
): Record<string, unknown> {
  const parameter = tool.headerParams?.find((p) => p.name.toLowerCase() === EDIT_REVISION_HEADER.toLowerCase());
  return parameter ? { ...args, [parameter.argument]: basis.editRevision } : { ...args };
}
