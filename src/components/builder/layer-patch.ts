/**
 * Whether an authoritative layer contains every value requested by a PATCH.
 * Server normalization may add derived fields (for example an aggregate fill),
 * so the comparison is intentionally subset-shaped rather than byte equality.
 */
export function layerContainsPatch(
  layer: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  return contains(layer, patch);
}

/**
 * Whether an authoritative map contains every value requested by a PATCH.
 * `layerOrder` is virtual — the server answers with the layers themselves,
 * in order — so acceptance reads the order off the embedded layer list.
 */
export function mapContainsPatch(
  map: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  return Object.entries(patch).every(([key, value]) => {
    if (key === "layerOrder") {
      const layers = map.layers;
      const order = Array.isArray(layers)
        ? (layers as { id?: unknown }[]).map((l) => l?.id)
        : [];
      return contains(order, value);
    }
    return key in map && contains(map[key], value);
  });
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => contains(actual[index], value))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(
      ([key, value]) => key in actual && contains(actual[key], value),
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
