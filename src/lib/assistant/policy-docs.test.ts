import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { buildTools } from "@/lib/tools/tools";
import { POLICY_REFUSAL_CODE } from "./policy";

/**
 * The page action policy is a documented API contract: the message
 * operation's description states it page by page, the error catalogue
 * carries the refusal, and the generated tool inventory is unchanged by
 * the enforcement.
 */

/** The generated tool count: the opening count of 113
 * plus schema-only catalogue read, plus spec two (the map check and
 * its image read). Enforcement adds no tool and removes none; a moved
 * count is a reviewed change, never a side effect of the policy.
 * Authenticated settings adds its read and update operations. Own-account
 * profile, password and token controls add six operations; user administration
 * adds four more. Token-addressed publication revocation adds one. A
 * project's people add their read and two changes, transfer three, and the
 * directory search one. Self-departure adds one. */
const GENERATED_TOOLS = 137;

describe("the page action policy is documented", () => {
  const document = buildOpenApiDocument();
  const description = String((document.paths["/api/assistant/messages"] as { post: { description: string } }).post.description);

  it("the message operation's description states the policy per page and names the refusal", () => {
    for (const page of ["builder context", "sql context", "workflow context", "no context"]) expect(description).toContain(page);
    expect(description).toContain("declare themselves read-only");
    expect(description).toContain("conditional (plan or run) operations included");
    expect(description).toContain("confirmation continuations");
    expect(description).toContain(POLICY_REFUSAL_CODE);
  });

  it("the error catalogue and the document's error codes carry the refusal", () => {
    expect(ERROR_CATALOGUE[POLICY_REFUSAL_CODE]).toMatch(/does not admit this operation; nothing was performed/);
    expect((document as unknown as { "x-error-codes": Record<string, string> })["x-error-codes"][POLICY_REFUSAL_CODE]).toBe(ERROR_CATALOGUE[POLICY_REFUSAL_CODE]);
  });

  it("the generated tool count is unchanged", () => {
    expect(buildTools()).toHaveLength(GENERATED_TOOLS);
  });

  it("no page-specific avoidance instruction reaches the model through a tool description", () => {
    // The review question made mechanical for the one place it can be: a
    // tool description that told the model to avoid an operation on a page
    // would be a warning where the API refuses instead (the phase rule).
    for (const tool of buildTools()) expect(tool.description, tool.name).not.toMatch(/\b(never|do not|don't) (call|use) this (on|from) the (builder|sql|workflow)/i);
  });
});
