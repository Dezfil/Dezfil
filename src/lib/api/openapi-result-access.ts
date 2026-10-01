import { ERROR_RESPONSE, type op } from "./openapi-helpers";

/** Results keep their initiator independently of the source's later lifetime. */
export function resultAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Private execution retains the initiating account through completion. Retained images and download receipts belong only to that account, including for administrators, even after the source or output is deleted. A copied result identifier has the same refusal as an unknown identifier and cannot consume or release the owner's result. Account activity is checked before returning bytes or retaining a new result; deactivation freezes access until reactivation. Reach is asked again where the work commits. A prepared layer download is refused on the claim when its layer, on a map the claimant does not own, or a dataset it drew that someone else owns has left the claimant's reach since the ticket, with the same answer as an expired ticket. A server render and a look check ask at every phase whether the caller still reaches the map and are refused as absent otherwise. A project export checks every selected member against the caller's reach as the archive completes and fails with export_failed naming the first one withdrawn rather than delivering a thinner archive. Results already issued (a query download, a retained look image, a project archive, an assistant answer) remain the initiator's for their retention lifetime after reach is withdrawn, as a copy they hold; they grant no new access to the source. " + (config.description ?? ""),
    responses: { ...config.responses, "401": ERROR_RESPONSE },
  };
}
