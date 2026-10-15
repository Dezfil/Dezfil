import { SATELLITE_MAX_ZOOM } from "@/lib/basemap";
import { ERROR_RESPONSE, pathParam } from "./openapi-helpers";

/** What every satellite tile operation says of how a tile comes back. */
export const SATELLITE_TILE_DESCRIPTION =
  "Fetched now by the server from the tile template this instance " +
  "configures and passed back, so the template and a key in it never " +
  "leave the server. Use the tile address the imagery style names. Only " +
  "the tile's z, x and y reach the template, each a whole number in plain " +
  `decimal, z from 0 to ${SATELLITE_MAX_ZOOM} and x and y below 2 to the ` +
  "power of z; anything else is refused with invalid_request before the " +
  "imagery is asked. No query, header or credential of the request goes " +
  "with them. The fetch takes the egress policy at every hop, waits at " +
  "most ten seconds and reads at most 4 MiB; only a whole PNG, JPEG, GIF, " +
  "WebP or AVIF image passes back, with the type its bytes are, and no " +
  "tile is stored. Every failure upstream answers imagery_unavailable, " +
  "whose message says what went wrong and never the tile address or its " +
  "key; a template carrying a user name or password is not drawn and " +
  "answers the same. An instance that configures no imagery answers 404 " +
  "as the style does; a stored template the instance's key no longer " +
  "opens is refused with service_address_unreadable. Private, no-store.";

export const SATELLITE_TILE_PARAMETERS = [
  pathParam("z", `Tile zoom, 0 to ${SATELLITE_MAX_ZOOM}.`),
  pathParam("x", "Tile column, below 2 to the power of z."),
  pathParam("y", "Tile row, below 2 to the power of z."),
];

const image = { schema: { type: "string", format: "binary" } };

export const SATELLITE_TILE_RESPONSES = {
  "200": {
    description: "The tile, as the imagery drew it.",
    content: {
      "image/png": image, "image/jpeg": image, "image/gif": image,
      "image/webp": image, "image/avif": image,
    },
  },
  "400": ERROR_RESPONSE,
  "404": { description: "No imagery is configured." },
  "502": ERROR_RESPONSE,
  "504": ERROR_RESPONSE,
};
