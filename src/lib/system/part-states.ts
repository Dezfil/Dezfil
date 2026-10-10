/**
 * Each part's state as the configuration read reports it and the Status
 * rows show it, read without starting anything. No server import here: the
 * System tab reads this module too.
 */
export interface PartStates {
  /** The engine that runs people's SQL: the library's version, whether the
   * engine has started, and the extensions it loaded, in load order. */
  readonly query_engine: { readonly version: string | null; readonly started: boolean; readonly extensions: readonly string[] };
  /** Whether the tile builder is a program where its setting points, and its
   * version once this server has run it. */
  readonly tile_builder: { readonly found: boolean; readonly version: string | null };
  /** Whether the image renderer's browser is a program where its setting
   * points, and how many images render at once. */
  readonly image_renderer: { readonly found: boolean; readonly imagesAtOnce: number };
  /** The metadata database's file name, without its folder. */
  readonly metadata_database: { readonly file: string };
}
