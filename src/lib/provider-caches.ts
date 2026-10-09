/** The three provider answer caches, each a folder under the data folder's
 * `cache`: the address finder's, travel time's and OpenStreetMap's. */
export const PROVIDER_CACHES = ["geocode", "isochrone", "overpass"] as const;
export type ProviderCache = (typeof PROVIDER_CACHES)[number];
