import { expect, it, vi } from "vitest";
import { prepareConfirmation } from "./confirmation";
import { buildTools } from "@/lib/tools/tools";
it("confirms a token identity without fetching publication content", async () => {
  const tool = { ...buildTools().find(t => t.name === "unpublish_map")!, confirmation: {
    target: "Revoke {target}?", consequence: "The public link will stop working.", subject: { path: null, argument: "token", name: "" },
  } };
  const fetchImpl = vi.fn();
  const result = await prepareConfirmation(tool, { id: "revoke", name: tool.name, args: { token: "known-token" } }, { baseUrl: "http://instance.test", fetchImpl });
  expect(result?.words.target).toBe("Revoke known-token?"); expect(fetchImpl).not.toHaveBeenCalled(); expect(result?.subject).toBeUndefined();
});
