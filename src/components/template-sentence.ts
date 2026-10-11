/** Where a dataset copied from a template came from, in the record's terms:
 * the template's id and the version that was copied. */
export function templateSentence(params: Record<string, unknown> | null): string {
  const id = typeof params?.template === "string" ? params.template : null;
  const version = typeof params?.version === "number" ? params.version : null;
  if (id === null) return "Copied from a template";
  return `Copied from the template ${id}${version === null ? "" : `, version ${version}`}`;
}
