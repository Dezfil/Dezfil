/** Fixture support is deliberately passive: no read, retry or mutable cache.
 * Capture before an interleaving when proving a stale refusal. */
export function captureBasis(value) {
  const editRevision = value?.editRevision ?? value?.recipe?.editRevision;
  if (typeof editRevision !== 'string' || !editRevision) throw new Error('The fixture must capture a read or accepted result with an edit revision.');
  return Object.freeze({ editRevision });
}

/** Omission and malformed strings remain available to negative probes. */
export function fixtureHeaders(basis, initial = {}) {
  const headers = new Headers(initial);
  if (basis !== undefined && basis !== null) headers.set('X-Edit-Revision', basis.editRevision);
  return Object.fromEntries(headers);
}

/** External arguments stay external. Only a fixture that explicitly supplies
 * a basis gets a default, and only after the advertised schema declares it. */
export function declaredToolArguments(tool, args, basis) {
  if (!basis || !tool?.inputSchema?.properties?.expected_revision || Object.hasOwn(args, 'expected_revision')) return args;
  return { ...args, expected_revision: basis.editRevision };
}
