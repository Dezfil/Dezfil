import type { Database } from "better-sqlite3";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { createApiToken } from "@/lib/auth/credentials";
import { requireRequestAuth } from "@/lib/auth/http";
import { executeTool } from "@/lib/tools/execute";
import { toolRequest } from "@/lib/tools/request";
import { buildTools, type ToolDef } from "@/lib/tools/tools";
import { testAccountRequest } from "./accounts";

/**
 * The three roads a person's action reaches the instance by: their session
 * cookie, an API token they made earlier, and the generated tool an agent
 * calls with that token (the embedded assistant and the MCP server call the
 * same tools). Each action is named once, by its tool and arguments, and sent
 * down any road to the shipped route.
 */
export const ROADS = ["cookie", "token", "tool"] as const;
export type Road = (typeof ROADS)[number];

const ORIGIN = "http://instance.test";
const dispatch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  dispatchAssistantTestRoute(new Request(String(input), init))) as typeof fetch;

function toolNamed(name: string): ToolDef {
  const tool = buildTools().find(candidate => candidate.name === name);
  if (!tool) throw new Error(`No generated tool named ${name}`);
  return tool;
}

/** An API token the account makes for itself through the token service. */
export function tokenFor(db: Database, actor: string, name = "Roads"): string {
  const context = requireRequestAuth(testAccountRequest(new Request(`${ORIGIN}/api/account`), db, actor), db);
  return createApiToken(context, name, db).secret;
}

export interface RoadAnswer {
  status: number;
  body: unknown;
}

/**
 * Call one documented operation as `actor` down `road`: by a fresh session
 * cookie from the same origin, by `token`, or through the generated tool with
 * `token`. A covered write carries `revision` as its edit basis.
 */
export async function callAs(db: Database, road: Road, actor: string, token: string, name: string,
  args: Record<string, unknown> = {}, revision?: string | null): Promise<RoadAnswer> {
  const tool = toolNamed(name);
  // The edit basis goes where the operation documents it: an argument when
  // the tool declares one, else the header.
  const declared = Boolean(tool.inputSchema.properties?.expected_revision);
  if (revision && declared) args = { ...args, expected_revision: revision };
  const headers: Record<string, string> = revision && !declared ? { "X-Edit-Revision": revision } : {};
  if (road === "tool") {
    const result = await executeTool(tool, args, ORIGIN, dispatch, { ...headers, authorization: `Bearer ${token}` });
    return { status: result.status, body: result.body };
  }
  const { url, init } = toolRequest(tool, args, ORIGIN, headers);
  let request = new Request(url, init);
  if (road === "cookie") request = testAccountRequest(request, db, actor);
  else request.headers.set("authorization", `Bearer ${token}`);
  const response = await dispatchAssistantTestRoute(request);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}

/** The refusal a narrowed rule answers with, on every road. */
export function ruleRefusalBody(rule: string, message: string) {
  return { error: { code: "rule_refused", message, rule } };
}
