/**
 * The documentation site's address. Every place the product points a reader
 * at a documentation page (a served description, a link in the app) builds
 * that page's full address from this one constant, so the site can move by
 * changing a single line.
 *
 * A page at `docs/<section>/<page>.md` in the repository is served at
 * `<DOCS_SITE_URL><section>/<page>/`.
 */
export const DOCS_SITE_URL = "https://dezfil.io/docs/";

/** The full site address of one documentation page, named by its section
 * and page, such as `api/http-api`. */
export function docsPageUrl(page: string): string {
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)+$/.test(page)) throw new Error(`Not a documentation page: ${page}`);
  return `${DOCS_SITE_URL}${page}/`;
}

/** The HTTP API guide, the reader's companion to the served description. */
export const HTTP_API_GUIDE_URL = docsPageUrl("api/http-api");

/** The MCP page, the companion to the MCP server card in Settings. */
export const MCP_GUIDE_URL = docsPageUrl("api/mcp");
