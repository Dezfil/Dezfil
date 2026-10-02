import { firstName, type PersonLabel } from "./people";

export function RunInitiator({ actor }: { actor?: PersonLabel | null }) {
  return <span data-run-initiator title={actor ? `${actor.name} (${actor.sqlName})` : undefined}>{actor ? firstName(actor.name) : "Unknown"}</span>;
}
