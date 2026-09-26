/**
 * The one unreachable-server sentence: every fetch that fails without a
 * server-authored message reports the same way, varying only the action
 * that failed. Tests assert the rendered sentence as their own literal,
 * never through this helper.
 */
export function serverUnreachable(action: string): string {
  return `Couldn't ${action}. Is the server reachable?`;
}
