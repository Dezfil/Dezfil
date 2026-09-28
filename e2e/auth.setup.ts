import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { request, type FullConfig } from "@playwright/test";
import { browserAccount, provisionJourney } from "../scripts/journey-auth.mjs";

export const authState = path.resolve(".claude/browser-auth.json");
export default async function setup(config: FullConfig) {
  // The first-run journey deliberately owns setup and uses empty contexts.
  if (process.env.DEZFIL_E2E_FIRST_RUN === "1") return;
  const baseURL = config.projects[0].use.baseURL!;
  await provisionJourney(baseURL, browserAccount);
  const client = await request.newContext({ baseURL, extraHTTPHeaders: { origin: new URL(baseURL).origin } });
  try {
    const signed = await client.post("/api/auth/sign-in", { data: { email: browserAccount.email, password: browserAccount.password } });
    if (signed.status() !== 200) throw new Error(`Browser fixture sign-in failed: ${signed.status()}`);
    await mkdir(path.dirname(authState), { recursive: true });
    await client.storageState({ path: authState });
    await chmod(authState, 0o600);
  } finally { await client.dispose(); }
}
