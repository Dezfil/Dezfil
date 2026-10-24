/** The picture a person representation carries: its version, present while
 * the person has a picture and new for every one they set. */
export const PICTURE_VERSION_PROPERTY = {
  type: "string",
  description:
    "The version of the person's picture, present while they have one and " +
    "new whenever it is replaced; absent while they have none, when their " +
    "initials stand in.",
} as const;

export const PROFILE_PICTURE_SCHEMAS = {
  Person: {
    type: "object",
    description:
      "A person a resource names where the app draws their face, such as " +
      "its owner. The display name, the SQL name and the picture's " +
      "version, never an email.",
    properties: {
      name: { type: "string" },
      sqlName: {
        type: "string",
        description: "The person's SQL name, the qualifier other people's SQL uses for their datasets.",
      },
      pictureVersion: PICTURE_VERSION_PROPERTY,
    },
    required: ["name", "sqlName"],
  },
};
