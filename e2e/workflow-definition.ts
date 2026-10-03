/** Compare executable step state independently of its parent document's edit facts. */
export function stepDefinitions(steps: unknown) {
  return (steps as Record<string, unknown>[]).map((step) => {
    const definition = { ...step };
    delete definition.editRevision;
    delete definition.lastChangedAt;
    return definition;
  });
}
