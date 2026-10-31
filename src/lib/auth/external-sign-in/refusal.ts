import { AuthError } from "../errors";
import { externalSignIn } from "./config";
export function requirePasswordSignIn(): void {
  if (externalSignIn().enabled) throw new AuthError("external_sign_in_only",
    "This instance signs people in through its sign-in service. Passwords and sign-in links are unavailable.", 403);
}
