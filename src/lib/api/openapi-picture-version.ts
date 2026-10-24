/** The picture a person representation carries: its version, present while
 * the person has a picture and new for every one they set. */
export const PICTURE_VERSION_PROPERTY = {
  type: "string",
  description:
    "The version of the person's picture, present while they have one and " +
    "new whenever it is replaced; absent while they have none, when their " +
    "initials stand in. GET /api/accounts/{sqlName}/picture?v=<version> " +
    "reads it.",
} as const;
