import { isDeletedActor, type AccountActor } from "@/lib/account-actor";
import { firstName } from "./people";

export function RunInitiator({ actor }: { actor?: AccountActor | null }) {
  const deleted = isDeletedActor(actor);
  return <span data-run-initiator title={actor && !deleted ? `${actor.name} (${actor.sqlName})` : undefined}>{deleted ? "Deleted account" : actor ? firstName(actor.name) : "Unknown"}</span>;
}
