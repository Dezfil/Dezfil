import type { ToolDef } from "@/lib/tools/tools";

/**
 * Discovery: an assistant-internal tool that searches the documented
 * metadata of the operations a run admits but its offer omitted, and
 * makes what it found callable on the run's subsequent requests through
 * the exchange's extension. It is not a documented operation and
 * generates no MCP tool (MCP never narrows an offer); every operation it
 * surfaces still runs through the normal documented executor, so holds.
 * It cannot widen admission, bypass a gate or extend the step budget: a
 * discovery call spends a step like any call, and the loop's cancellation
 * checks stop it like any call.
 */

export const DISCOVERY_TOOL = "find_operations";
export const DISCOVERY_LIMIT = 8;

/** The definition the model is offered, shaped like a tool. */
export function discoveryDefinition(): ToolDef {
  return {
    name: DISCOVERY_TOOL,
    description:
      "Find operations this run can call that are not in your current tool list. " +
      "Search by what you want to do (for example 'duplicate a map', 'palette', 'publish'); " +
      "each match is added to your tools for the rest of this conversation, with its full input schema.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What you want to do, in a few words." } }, required: ["query"] },
    method: "get", path: "", confirm: false,
    effects: { readOnly: true, writes: [] },
    display: { verb: "Looked up operations for {arg.query}" },
    relevance: [],
    upload: false, bodyKeys: ["query"], pathParams: [], queryParams: [],
  };
}

export interface DiscoveryMatch { name: string; description: string; inputSchema: ToolDef["inputSchema"] }

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Rank the candidates by how many of the query's words their name or
 * description carry; a name hit counts double. */
export function findOperations(query: string, candidates: ToolDef[]): { matches: ToolDef[]; remaining: number } {
  const terms = words(query);
  const scored = candidates.map((tool) => {
    const name = tool.name.replace(/_/g, " ");
    const description = tool.description.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 2 : 0) + (description.includes(term) ? 1 : 0), 0);
    return { tool, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  const matches = scored.slice(0, DISCOVERY_LIMIT).map((entry) => entry.tool);
  return { matches, remaining: Math.max(0, scored.length - matches.length) };
}

export function discoveryBody(found: { matches: ToolDef[]; remaining: number }): { operations: DiscoveryMatch[]; remaining: number; note: string } {
  return {
    operations: found.matches.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    remaining: found.remaining,
    note: found.matches.length
      ? "These operations are now in your tool list and can be called."
      : "No further operation matches; what this run can call is already in your tool list.",
  };
}
