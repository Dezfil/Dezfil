import type { DeletionPreview } from "@/lib/auth/account-deletion-preview";
import type { DeletionStatus } from "@/lib/auth/account-deletion";
import { accountRequest } from "../settings/api";

export type { DeletionPreview, DeletionStatus };
export const readDeletionPreview = (id: string) =>
  accountRequest<DeletionPreview | DeletionStatus>(`/api/users/${encodeURIComponent(id)}/deletion-preview`);
export const deleteAccount = (preview: DeletionPreview, email: string) =>
  accountRequest<DeletionStatus>(`/api/users/${encodeURIComponent(preview.account.id)}`, "DELETE", {
    confirm: true, confirmation: preview.confirmation, ...(preview.invited ? {} : { email }),
  });
export const finishDeletion = (id: string) =>
  accountRequest<DeletionStatus>(`/api/users/deletions/${encodeURIComponent(id)}/finish`, "POST");
/** A deletion's status, or null once it has left the store: finished,
 * or never committed. Any other refusal throws. */
export async function readDeletionStatus(id: string): Promise<DeletionStatus | null> {
  const response = await fetch(`/api/users/deletions/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Deletion status ${response.status}`);
  return response.json() as Promise<DeletionStatus>;
}
