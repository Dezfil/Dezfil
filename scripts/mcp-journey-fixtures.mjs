/** Fixed before the implementation's first spatial query.
 * At latitude zero EPSG:3857 has metre units: .00449 degrees is about
 * 499.82 m and .00451 is about 502.05 m. The near miss must be excluded.
 * These literal identities are the oracle, never the query's row count.
 */
export const stationsCsv = "name,lon,lat\nwest,0,0\neast,0.02,0\n";
export const parksCsv = [
  "name,lon,lat,area_ha",
  "west_inner,0.004,0,10",
  "west_edge,0.00449,0,20",
  "west_near_miss,0.00451,0,30",
  "east_inner,0.024,0,40",
  "far,0.04,0,50",
  "",
].join("\n");
export const matchingParkNames = ["east_inner", "west_edge", "west_inner"];
export const refinedParkNames = ["east_inner", "west_edge"];
export const distanceMetres = 500;
export const metricCrs = "EPSG:3857";
