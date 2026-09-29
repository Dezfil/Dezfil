import { ERROR_RESPONSE, type op } from "./openapi-helpers";

/** Results keep their initiator independently of the source's later lifetime. */
export function resultAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Private execution retains the initiating account through completion. Retained images and download receipts belong only to that account, including for administrators, even after the source or output is deleted. A copied result identifier has the same refusal as an unknown identifier and cannot consume or release the owner's result. Account activity is checked before returning bytes or retaining a new result; deactivation freezes access until reactivation. " + (config.description ?? ""),
    responses: { ...config.responses, "401": ERROR_RESPONSE },
  };
}
