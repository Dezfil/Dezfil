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
