import { accountChoiceSchema } from "@/lib/settings/account";
import { settingDefinition } from "@/lib/settings/catalogue";
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
            "The signed-in account's display name, per-screen view/sort preferences and " +
            "how the SQL console's source list groups datasets, " +
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
        },
        required: ["displayName", "instanceName", "viewPrefs", "sourceGrouping"],
      },
    },
  };
}
