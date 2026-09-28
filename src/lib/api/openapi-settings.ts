import { op, jsonOk } from "./openapi-helpers";
import { READ_ONLY, writes, resource } from "./operation-metadata";

/** The per-screen view preferences (the workflows list,
 * the Projects list): one slice per list screen, each holding the view
 * and the screen's own sort. Documented on the update body and on the
 * settings read alike. */
function viewPrefsSchema() {
  const slice = (description: string, sorts: string[]) => ({
    type: "object",
    description,
    properties: {
      view: { type: "string", enum: ["grid", "list"] },
      sort: { type: "string", enum: sorts },
    },
  });
  return {
    type: "object",
    description:
      "Per-screen view preferences; slices merge into what is " +
      "stored, and the read carries every slice written so far.",
    properties: {
      maps: slice("The Maps list.", ["edited", "created", "name"]),
      data: slice("The Data page.", ["updated", "name", "rows", "size"]),
      workflows: slice("The workflows list.", ["edited", "created", "name"]),
      projects: slice("The Projects list.", ["updated", "name", "largest"]),
    },
  };
}

export function settingsContract() {
  return {
    paths: {
      "/api/settings": {
        get: op({
          summary: "Workspace settings",
          description:
            "Single-user workspace preferences — the display name shown " +
            "behind the rail avatar, the optional instance " +
            "name shown beside the wordmark and in browser titles (" +
            "null when unnamed), and the Maps/Data screens' view " +
            "mode + sort.",
          tag: "System",
          // Deliberately outside the agent tool set: a UI identity
          // preference, not a map capability.
          tool: false,
          effects: READ_ONLY,
          responses: {
            "200": jsonOk("#/components/schemas/WorkspaceSettings"),
          },
        }),
        patch: op({
          summary: "Update workspace settings",
          tag: "System",
          tool: false,
          effects: writes(resource("settings")),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    displayName: {
                      type: "string",
                      maxLength: 80,
                      description: "The workspace display name.",
                    },
                    instanceName: {
                      type: ["string", "null"],
                      maxLength: 80,
                      description:
                        "The optional instance name. Empty, whitespace or " +
                        "null clears it; the instance is then unnamed.",
                    },
                    viewPrefs: viewPrefsSchema(),
                  },
                },
                example: { displayName: "Ada Lovelace" },
              },
            },
          },
          responses: {
            "200": jsonOk("#/components/schemas/WorkspaceSettings"),
          },
        }),
      },
    },
    schemas: {
      WorkspaceSettings: {
        type: "object",
        properties: {
          displayName: {
            type: "string",
            description:
              "The workspace display name; its initials badge the rail " +
              "avatar until real accounts exist.",
          },
          instanceName: {
            type: ["string", "null"],
            description:
              "The instance's optional name: shown beside " +
              "the wordmark and as the browser-title tail. Null when " +
              "the instance is unnamed.",
          },
          viewPrefs: viewPrefsSchema(),
        },
        required: ["displayName", "instanceName"],
      },
    },
  };
}
