import { KIND_OF, type SettingDefinition, type SettingValue, type WriteConstraint } from "./types";

/**
 * How long sign-ins and links last, when failed sign-ins pause, the
 * shortest password, and who may create tokens, publish, embed published
 * pages, add database connections and import from links: stored instance
 * settings an admin changes, set by no variable, so no deployment pins one.
 * Each default is the product's own behavior before these settings existed.
 *
 * Data only, like the rest of the catalogue. The four rules, embedding and a
 * new token's lifetime are read by every signed-in account, whose screens
 * follow them; the shortest password by anyone, since the entry screens
 * name it; the rest by admins alone. Number-like choices are text, as the
 * defaults' are; their readers parse them.
 */
function row<const K extends string, const W extends WriteConstraint>(
  key: K, readBy: "signed-in" | "public" | "admin", label: string, purpose: string,
  defaultValue: SettingValue, write: W, unit?: string,
): SettingDefinition & { readonly key: K; readonly write: W } {
  return {
    key, label, purpose, defaultValue,
    documentedDefault: Array.isArray(defaultValue) ? (defaultValue.length ? defaultValue.join(", ") : "none") : String(defaultValue),
    scope: "instance", readBy, changedBy: "admin", kind: KIND_OF[write.kind],
    timing: "live", secret: false, editable: true, write, ...(unit ? { unit } : {}),
  };
}
const choice = <const V extends readonly string[]>(...values: V) => ({ kind: "choice", values }) as const;
const integer = (min: number, max: number) => ({ kind: "integer", min, max }) as const;

export const INSTANCE_SECURITY_SETTINGS = [
  row("security.sessionDays", "admin", "Stay signed in for",
    "How long a session lasts after its last use. A session keeps the expiry it holds; its next use renews it by this length.",
    "30", choice("1", "7", "30", "90"), "days"),
  row("security.linkDays", "admin", "Invite and reset links last",
    "How long an invitation or a password reset link stays valid. A link keeps the lifetime it was issued with.",
    "7", choice("1", "3", "7", "14"), "days"),
  row("security.failedPerAccount", "admin", "Failed sign-ins per account",
    "Failed sign-ins for one account, within a fixed 15 minutes, before its next attempt pauses. Never above the count per address.",
    5, integer(3, 100), "per 15 minutes"),
  row("security.failedPerAddress", "admin", "Failed sign-ins per address",
    "Failed sign-ins from one network address, within a fixed 15 minutes, before its next attempt pauses. Never below the count per account.",
    20, integer(10, 1000), "per 15 minutes"),
  row("security.passwordMin", "public", "Shortest password",
    "The fewest characters a password set from now may have. Passwords set earlier keep signing in.",
    8, integer(8, 64), "characters"),
  row("tokens.create", "signed-in", "Who may create tokens",
    "Whether every account or only admins may create API tokens. Tokens made earlier keep working.",
    "everyone", choice("everyone", "admins")),
  row("tokens.expiry", "signed-in", "New tokens expire after",
    "The lifetime a new API token takes, from its creation. Tokens made earlier keep their own.",
    "never", choice("never", "30d", "90d", "1y")),
  row("publishing.publish", "signed-in", "Who may publish",
    "Whether every account, only admins or no one may publish a map or change a publication. Published maps stay public and can be unpublished.",
    "everyone", choice("everyone", "admins", "none")),
  row("publishing.embedding", "signed-in", "Embedding on other sites",
    "Which other sites may show a published page in a frame: any site, only the listed sites (at least one), or none.",
    "any", choice("any", "listed", "off")),
  row("publishing.embedSites", "admin", "Listed sites",
    "The sites that may show a published page in a frame while embedding is limited to listed sites; never empty while it is.",
    [], { kind: "sites", maxSites: 50 }),
  row("connections.create", "signed-in", "Who may add database connections",
    "Whether every account or only admins may add a database connection. Connections made earlier keep working.",
    "everyone", choice("everyone", "admins")),
  row("imports.links", "signed-in", "Who may import from links",
    "Whether every account or only admins may import from web addresses and cloud storage. Link datasets keep refreshing.",
    "everyone", choice("everyone", "admins")),
] as const;
