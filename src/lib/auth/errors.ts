export type AuthErrorCode =
  | "authentication_busy" | "authentication_required" | "invalid_credentials" | "account_deactivated"
  | "already_signed_in" | "account_not_invited" | "invalid_ticket" | "external_sign_in_only" | "setup_complete" | "weak_password" | "email_taken" | "self_change_refused"
  | "account_not_deactivated" | "deletion_in_progress" | "deletion_changed" | "deletion_unreadable"
  | "last_admin" | "forbidden" | "invalid_link" | "current_password_required"
  | "invalid_request" | "not_found" | "ingress_unavailable" | "rate_limited" | "token_expired" | "token_outdated"
  /** An instance rule an admin set excludes the acting account from this
   * action; the envelope names the rule. */
  | "rule_refused";

/** Transport-independent failures; entry and account routes map these to their contract. */
export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message: string,
    public readonly status: number, public readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** The departed caller receives no credential or account mutation. */
export class AuthenticationCancelled extends Error {
  constructor(public readonly derivationStarted = false) { super("Authentication was cancelled."); this.name = "AbortError"; }
}

export function requireAuthenticationWanted(signal?: AbortSignal, derivationStarted = false): void {
  if (signal?.aborted) throw new AuthenticationCancelled(derivationStarted);
}
