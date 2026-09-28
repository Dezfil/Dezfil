export type AuthErrorCode =
  | "authentication_required" | "invalid_credentials" | "account_deactivated"
  | "setup_complete" | "weak_password" | "email_taken" | "self_change_refused"
  | "last_admin" | "forbidden" | "invalid_link" | "current_password_required"
  | "invalid_request" | "not_found" | "ingress_unavailable" | "rate_limited";

/** Transport-independent failures; entry and account routes map these to their contract. */
export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message: string,
    public readonly status: number, public readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}
