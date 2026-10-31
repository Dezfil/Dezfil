import { accountRequest } from "@/components/settings/api";

/** Whether this instance signs people in through a sign-in service, from the
 * configuration read. A read that fails, or does not say, rejects: a screen
 * that does not know the mode offers nothing the mode might refuse. */
export async function readExternalMode(): Promise<boolean> {
  const config = await accountRequest<{ externalSignIn?: { enabled?: unknown } }>("/api/config");
  const enabled = config.externalSignIn?.enabled;
  if (typeof enabled !== "boolean") throw new Error("This instance's sign-in mode could not be read. Try again.");
  return enabled;
}
