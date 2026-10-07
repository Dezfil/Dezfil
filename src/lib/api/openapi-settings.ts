import { accountChoiceSchema } from "@/lib/settings/account";
import { settingDefinition } from "@/lib/settings/catalogue";
import { LOOK_KEYS } from "@/lib/look";
import { op, jsonOk, ERROR_RESPONSE } from "./openapi-helpers";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { AUTH_SECURITY } from "./openapi-auth";

/** The per-screen view preferences (the workflows list,
 * the Projects list): one slice per list screen, each holding the view
 * and the screen's own sort. Documented on the update body and on the
 * settings read alike. */
function viewPrefsSchema() {
  const slice = (screen: string, description: string) => ({
    type: "object",
    description,
    properties: {
      view: accountChoiceSchema(`${screen}.view`),
      sort: accountChoiceSchema(`${screen}.sort`),
    },
  });
  return {
    type: "object",
    description:
      "Per-screen view preferences; slices merge into what is " +
      "stored, and the read carries every slice written so far.",
    properties: {
      maps: slice("maps", "The Maps list."),
      data: slice("data", "The Data page."),
      workflows: slice("workflows", "The workflows list."),
      projects: slice("projects", "The Projects list."),
    },
  };
}

/** The account's look: the six picks, each property built from its catalogue
 * definition, closed to unknown keys. The read carries every pick; the
 * update takes any of them and leaves the rest as they are. */
function lookSchema(position: "read" | "update") {
  return {
    type: "object",
    additionalProperties: false,
    description: position === "read"
      ? "Your look, every pick at its kept value or its default; a kept value this version no longer offers reads as " +
        "its default. It follows you to every browser you sign in to; published pages and exported images keep the default look."
      : "Any of your look's picks; the others stay as they are. A value outside a pick's choices, or a key that is not " +
        "one of the picks, refuses the whole update, naming it as look.<key>.",
    properties: Object.fromEntries(LOOK_KEYS.map(key => {
      const definition = settingDefinition(`look.${key}`);
      return [key, { ...accountChoiceSchema(`look.${key}`), default: definition.defaultValue,
        description: `${definition.label}. ${definition.purpose}` }];
    })),
    ...(position === "read" ? { required: [...LOOK_KEYS] } : {}),
  };
}

/** How the SQL console's source list groups datasets, one account's choice. */
const sourceGroupingSchema = () => ({
  ...accountChoiceSchema("sourceGrouping"),
  default: settingDefinition("sourceGrouping").defaultValue,
  description:
    "How the SQL console's source list groups datasets: by person (your own, then each other person's " +
    "under their name and SQL name) or by project. Your own choice, never another account's; person " +
    "until you choose otherwise.",
});

export function settingsContract() {
  return {
    paths: {
      "/api/settings": {
        get: { ...op({
          summary: "Workspace settings",
          description:
            "The signed-in account's display name, per-screen view/sort preferences, " +
            "how the SQL console's source list groups datasets and its look (color, contrast, typeface, " +
            "background, corners and side menu), " +
            "plus the instance name shown beside the wordmark and in browser titles " +
            "(null when unnamed). Cookie or bearer authentication is required. " +
            "Responses, including refusals, are private, no-store.",
          tag: "System",
          tool: "get_settings",
          display: { verb: "Read your settings" },
          mcp: LOCAL_READ,
          effects: READ_ONLY,
          responses: {
            "200": jsonOk("#/components/schemas/WorkspaceSettings"),
            "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE,
          },
        }), security: AUTH_SECURITY },
        patch: { ...op({
          summary: "Update your settings",
          description: "Updates only the authenticated account's display name and preferences. " +
            "Only admins can change instanceName. The entire patch is validated and authorized " +
            "before any write; a forbidden or invalid field leaves every field unchanged. " +
            "The look takes any of its picks; an unknown pick or value inside look refuses the patch, " +
            "while an unknown field outside it is ignored. " +
            "Cookie mutations require the same trusted Origin. Explicit bearer requests need no " +
            "cookie or Origin. Responses, including refusals, are private, no-store.",
          tag: "System",
          tool: "update_settings",
          display: { verb: "Updated your settings" },
          mcp: LOCAL_REPLACE,
          effects: writes(resource("settings"), resource("accounts")),
          requestBody: {
            "x-byte-limit": 16_777_216,
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    displayName: {
                      type: "string",
                      maxLength: 80,
                      description: "Your account display name.",
                    },
                    instanceName: {
                      type: ["string", "null"],
                      maxLength: 80,
                      description:
                        "Admin-only optional instance name. Empty, whitespace or " +
                        "null clears it; the instance is then unnamed.",
                    },
                    viewPrefs: viewPrefsSchema(),
                    sourceGrouping: sourceGroupingSchema(),
                    look: lookSchema("update"),
                  },
                },
                example: { displayName: "Ada Lovelace" },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/WorkspaceSettings"),
            "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE,
          },
        }), security: AUTH_SECURITY },
      },
    },
    schemas: {
      WorkspaceSettings: {
        type: "object",
        properties: {
          displayName: {
            type: "string",
            description:
              "The authenticated account's display name.",
          },
          instanceName: {
            type: ["string", "null"],
            description:
              "The instance's optional name: shown beside " +
              "the wordmark and as the browser-title tail. Null when " +
              "the instance is unnamed.",
          },
          viewPrefs: viewPrefsSchema(),
          sourceGrouping: sourceGroupingSchema(),
          look: lookSchema("read"),
        },
        required: ["displayName", "instanceName", "viewPrefs", "sourceGrouping", "look"],
      },
    },
  };
}
