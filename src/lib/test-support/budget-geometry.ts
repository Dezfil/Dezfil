/** Valid native lines whose independently known compact GeoJSON sizes match
 * large coastline controls, without downloading data. Coordinates stay within
 * longitude/latitude ranges; no empty properties are used to inflate them. */
export function geometryOfBytes(bytes: number, type: "LineString" | "MultiPoint" = "LineString"): string {
  const prefix = `{"type":"${type}","coordinates":[`;
  const fixed = Buffer.byteLength(prefix) + 1;
  const points = Math.floor((bytes - fixed) / 10);
  const extra = bytes - fixed - points * 10;
  const x = `0.${"5".repeat(extra + 1)}`, y = 0.5;
  return `ST_GeomFromGeoJSON('${prefix}' || repeat('[0.5,0.5],', ${points - 1}) || '[${x},${y}]]}')`;
}

export function countryGeometryRows(): string {
  const other = Math.floor((12_395_238 - 1_573_724) / 257);
  const second = 12_395_238 - 1_573_724 - other * 256;
  return `SELECT range AS id, CASE range WHEN 0 THEN ${geometryOfBytes(1_573_724)} WHEN 1 THEN ${geometryOfBytes(second)} ELSE ${geometryOfBytes(other)} END AS coast FROM range(258)`;
}
