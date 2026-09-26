/** Consequence declarations, attached explicitly to each OpenAPI operation.
 * Read-only comes from x-effects. Omitted repeatability has an explicit reason;
 * MCP's default for omitted idempotentHint is false.
 */
export interface McpConsequences {
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
  repeatability?: string;
}
export const LOCAL_READ: McpConsequences = { destructiveHint: false, openWorldHint: false, idempotentHint: true };
export const REMOTE_READ: McpConsequences = { destructiveHint: false, openWorldHint: true, repeatability: 'External entities and retained provider state may change between identical calls.' };
export const LOCAL_ADD: McpConsequences = { destructiveHint: false, openWorldHint: false, idempotentHint: false };
export const REMOTE_ADD: McpConsequences = { destructiveHint: false, openWorldHint: true, idempotentHint: false };
export const LOCAL_REPLACE: McpConsequences = { destructiveHint: true, openWorldHint: false, repeatability: 'Identical calls may update retained working state.' };
export const REMOTE_REPLACE: McpConsequences = { destructiveHint: true, openWorldHint: true, repeatability: 'Identical calls may update retained working state and interact with external entities.' };
export const LOCAL_DELETE: McpConsequences = { destructiveHint: true, openWorldHint: false, idempotentHint: true };
export const HISTORY_MOVE: McpConsequences = { destructiveHint: true, openWorldHint: false, idempotentHint: false };
export const WORKFLOW_RUN: McpConsequences = { destructiveHint: true, openWorldHint: true, idempotentHint: false };
export const MAP_LOOK: McpConsequences = { destructiveHint: false, openWorldHint: true, idempotentHint: false };

export const LOCAL_TRANSIENT_READ: McpConsequences = { destructiveHint: false, openWorldHint: false, idempotentHint: false };
