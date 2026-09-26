/** Run every requested refresh in order. One failure is one row's outcome,
 * not permission to skip the rows after it. A cancelled run stops before
 * starting the next row; the row already in flight owns its own
 * abandonment. */
export async function refreshSequentially(
  names: string[],
  refresh: (name: string) => Promise<void>,
  onSettled: (name: string) => void = () => {},
  signal?: AbortSignal,
): Promise<void> {
  for (const name of names) {
    if (signal?.aborted) return;
    try {
      await refresh(name);
    } catch {
      // The refresh function owns the row's failure presentation.
    } finally {
      onSettled(name);
    }
  }
}
