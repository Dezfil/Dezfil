/**
 * What an admin sets for the entry screen, as the entry screen and the
 * Settings page both draw it: the sign-in page's lost-password line, and
 * the pages a person can land on after signing in.
 */

/** The pages a person can land on after signing in, in the order offered. */
export const LANDING_PAGES = [
  { value: "home", label: "Home", route: "/" },
  { value: "projects", label: "Projects", route: "/projects" },
  { value: "maps", label: "Maps", route: "/maps" },
  { value: "workflows", label: "Workflows", route: "/workflows" },
  { value: "data", label: "Data", route: "/data" },
  { value: "sql", label: "SQL", route: "/sql" },
] as const;

/** The sign-in page's line about a lost password: the contact named, its
 * trailing period dropped so the sentence ends once, or the built-in line. */
export function forgotLine(contact: string | null | undefined): string {
  const named = String(contact ?? "").trim().replace(/[.\s]+$/, "");
  return named ? `Forgot your password? Ask ${named}.` : "Forgot your password? An admin can reset it.";
}

/** Where a person lands after signing in: the chosen page's own route, or
 * Home for anything else. The stored value is never used as an address. */
export function landingRoute(value: unknown): string {
  return LANDING_PAGES.find(page => page.value === value)?.route ?? "/";
}
