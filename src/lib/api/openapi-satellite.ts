import { SATELLITE_MAX_ZOOM } from "@/lib/basemap";
import { TOKEN_LENGTH } from "@/lib/publish/token";
import { ERROR_RESPONSE, op, pathParam } from "./openapi-helpers";
import { publicationAccess } from "./openapi-publications";
import { READ_ONLY } from "./operation-metadata";

/** What every satellite tile operation says of how a tile comes back. */
export const SATELLITE_TILE_DESCRIPTION =
  "Fetched now by the server from the tile template this instance " +
  "configures and passed back, so the template and a key in it never " +
  "leave the server. Use the tile address the imagery style names. Only " +
  "the tile's z, x and y reach the template, each a whole number in plain " +
  `decimal, z from 0 to ${SATELLITE_MAX_ZOOM} and x and y below 2 to the ` +
  "power of z, the row followed by @2x for a high-density tile or by " +
  "nothing; anything else is refused with invalid_request before the " +
  "imagery is asked. The template is filled from these alone as MapLibre " +
  "fills a raster template: {z}, {x}, {y} (counted by the style source's " +
  "scheme), {ratio} (@2x or nothing), {quadkey}, {prefix} and " +
  "{bbox-epsg-3857}. No query, header or credential of the request goes " +
  "with them. The fetch takes the egress policy at every hop, waits at " +
  "most ten seconds and reads at most 4 MiB; only a whole PNG, JPEG, GIF, " +
  "WebP or AVIF image passes back, with the type its bytes are, and no " +
  "tile is stored. Every failure upstream answers imagery_unavailable, " +
  "whose message says what went wrong and never the tile address or its " +
  "key; a template carrying a user name or password is not drawn and " +
  "answers the same. Private, no-store.";

/** How the signed-in style and its tiles answer an instance with no imagery. */
export const SATELLITE_TILE_SIGNED_IN =
  "An instance that configures no imagery answers 404 as the style does; a " +
  "stored template the instance's key no longer opens is refused with " +
  "service_address_unreadable.";

export const SATELLITE_TILE_PARAMETERS = [
  pathParam("z", `Tile zoom, 0 to ${SATELLITE_MAX_ZOOM}.`),
  pathParam("x", "Tile column, below 2 to the power of z."),
  pathParam("y", "Tile row, below 2 to the power of z, followed by @2x for a high-density tile."),
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
  "502": {
    ...ERROR_RESPONSE,
    description: "imagery_unavailable: the imagery failed, or this instance's egress policy refused its address.",
    headers: {
      "X-Dezfil-Egress-Refused": {
        description: "imagery where the egress policy refused the imagery's address, at its host or at a " +
          "redirect; absent for every other failure. An image export that meets it refuses its image " +
          "rather than make it without the imagery.",
        schema: { type: "string", const: "imagery" },
      },
    },
  },
  "504": ERROR_RESPONSE,
};

const READER_SCOPE =
  "Served under the publish token only while the publication resolves, as " +
  "its layer tiles are: a revoked or unknown token answers the same clean " +
  "not_found, and so does a publication whose reader is not shown " +
  "Satellite (the map is not on it, and its basemap switcher is off or no " +
  "longer offers it). An instance with no imagery to draw now, none " +
  "configured or a stored template its key no longer opens, answers 404 as " +
  "the signed-in style does while none is configured.";

/** The satellite style and its tiles as a published map's reader reaches
 * them, under the publication's own token. */
export const PUBLISHED_SATELLITE_PATHS = {
  "/api/published/{token}/basemaps/satellite": {
    get: op(publicationAccess({
      summary: "The imagery style of a published map",
      description:
        "The imagery style for a published page's reader, who is not signed " +
        "in: the signed-in style's document, its raster source naming this " +
        "publication's own tile address, " +
        "`/api/published/{token}/basemaps/satellite/tiles/{z}/{x}/{y}{ratio}`, never " +
        "the configured tile template. The published view's basemapUrl and the " +
        "page's basemap switcher name this address. In the view budget. " +
        READER_SCOPE + " Private, no-store.",
      tag: "Publish",
      tool: false,
      effects: READ_ONLY,
      parameters: [pathParam("token", `Publish token (${TOKEN_LENGTH} characters).`)],
      responses: {
        "200": {
          description: "The style document.",
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        "404": {
          description: "The publication is not current or does not show Satellite (not_found), or no imagery is configured.",
          content: ERROR_RESPONSE.content,
        },
      },
    })),
  },
  "/api/published/{token}/basemaps/satellite/tiles/{z}/{x}/{y}": {
    get: op(publicationAccess({
      summary: "One imagery tile of a published map",
      description:
        `${SATELLITE_TILE_DESCRIPTION} In the tile budget. ${READER_SCOPE} The ` +
        "token is checked again once the tile has come, so a publication " +
        "revoked meanwhile passes nothing back.",
      tag: "Publish",
      tool: false,
      effects: READ_ONLY,
      parameters: [pathParam("token", `Publish token (${TOKEN_LENGTH} characters).`), ...SATELLITE_TILE_PARAMETERS],
      responses: {
        ...SATELLITE_TILE_RESPONSES,
        "404": {
          description: "The publication is not current or does not show Satellite (not_found), or no imagery is configured.",
          content: ERROR_RESPONSE.content,
        },
      },
    })),
  },
};
