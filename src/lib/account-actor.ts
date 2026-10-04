/** Historical attribution is distinct from an account profile or a SQL home.
 * Unknown is null; a deleted actor deliberately carries neither name. */
export type AccountActor = { name: string; sqlName: string } | { deleted: true };

export function isDeletedActor(actor: AccountActor | null | undefined): actor is { deleted: true } {
  return !!actor && "deleted" in actor;
}
