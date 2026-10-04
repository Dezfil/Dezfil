/** Valid native lines whose independently known compact GeoJSON sizes match
 * large coastline controls, without downloading data. Coordinates stay within
 * longitude/latitude ranges; no empty properties are used to inflate them. */
export function geometryOfBytes(bytes: number): string {
  const prefix = '{"type":"LineString","coordinates":[';
  const fixed = Buffer.byteLength(prefix) + 1;
  const points = Math.floor((bytes - fixed) / 6);
  const extra = bytes - fixed - points * 6;
  const [x, y] = [[1, 1], [10, 1], [100, 1], [-100, 1], [-100, 10], [-100, -90]][extra];
  return `ST_GeomFromGeoJSON('${prefix}' || repeat('[0,0],', ${points - 1}) || '[${x},${y}]]}')`;
}

export function countryGeometryRows(): string {
  const other = Math.floor((12_395_238 - 1_573_724) / 257);
  const second = 12_395_238 - 1_573_724 - other * 256;
  return `SELECT range AS id, CASE range WHEN 0 THEN ${geometryOfBytes(1_573_724)} WHEN 1 THEN ${geometryOfBytes(second)} ELSE ${geometryOfBytes(other)} END AS coast FROM range(258)`;
}
