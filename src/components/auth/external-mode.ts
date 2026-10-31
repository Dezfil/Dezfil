/** Whether this instance signs people in through a sign-in service, from the
 * configuration read. A read that fails says no: the screens then offer what
 * they offer today, and the server still refuses it in its own words. */
export function readExternalMode(): Promise<boolean> {
  return fetch("/api/config", { cache: "no-store" })
    .then(response => response.ok ? response.json() : null)
    .then(config => config?.externalSignIn?.enabled === true)
    .catch(() => false);
}
