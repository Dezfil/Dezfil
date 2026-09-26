# DuckDB spatial in Dezfil

The query tool executes read-only DuckDB SQL on the server. Catalogue and
schema reads identify table and column names. Double quotes delimit identifiers
and doubled quotes escape a quote inside one; single quotes delimit text.
Spatial values are GEOMETRY. WKT, WKB and GeoJSON are encodings converted with
the corresponding constructors. A map query supplies a geometry column along
with the attributes it styles. The query API returns a preview and geometry
facts; the layer retains its editable SQL.

```sql
-- example: encoding
SELECT ST_AsText(ST_GeomFromText('POINT (13.4 52.5)')) AS wkt,
       ST_AsText(ST_GeomFromWKB(ST_AsWKB(ST_Point(13.4, 52.5)))) AS wkb_roundtrip,
       ST_AsText(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[13.4,52.5]}')) AS geojson_roundtrip,
       'quoted' AS "label with space"
```

## Exact spatial questions

Bounding boxes supply conservative candidates, not the exact answer.
Intersection keeps a feature that crosses the boundary; containment asks
whether the whole feature is within it. A boundary-only touch intersects but
does not put a point within a polygon's interior.

```sql
-- example: crossing
WITH area AS (SELECT ST_MakeEnvelope(0, 0, 2, 2) AS g),
features AS (
  SELECT id, ST_GeomFromText(wkt) AS g FROM (VALUES
    ('crossing', 'LINESTRING (-1 1, 3 1)'),
    ('inside', 'POINT (1 1)'),
    ('outside', 'POINT (3 3)')
  ) AS f(id, wkt)
)
SELECT id, ST_Within(features.g, area.g) AS wholly_within
FROM features, area
WHERE ST_Intersects_Extent(features.g, area.g)
  AND ST_Intersects(features.g, area.g)
ORDER BY id
```

Distance candidates expand the search box in the same coordinate units as
the exact distance predicate. This local planar example uses metre coordinates;
the nearby points have nonoverlapping boxes with the origin and remain matches.

```sql
-- example: distance
WITH points AS (
  SELECT id, ST_Point(x, 0) AS g FROM (VALUES
    ('near_east', 400), ('near_west', -400), ('near_miss', 501)
  ) AS f(id, x)
)
SELECT id FROM points
WHERE ST_Intersects_Extent(g, ST_MakeEnvelope(-500, -500, 500, 500))
  AND ST_DWithin(g, ST_Point(0, 0), 500)
ORDER BY id
```

## Projection, axes and measurement

Longitude/latitude input uses x = longitude and y = latitude. With
`always_xy := true`, transformation uses that order. A suitable projected CRS
supplies its documented linear units; local UTM is useful within its zone.
EPSG:3857 has metre coordinates but increasing scale distortion away from the
equator. A planar EPSG:4326 distance has degree units. DuckDB's spheroid distance
function takes latitude/longitude order and returns metres; the first spheroid
example supplies latitude first explicitly.

```sql
-- example: units-axis
WITH projected AS (
  SELECT ST_Transform(ST_Point(13.4, 52.5), 'EPSG:4326', 'EPSG:32633', always_xy := true) AS g
)
SELECT ST_X(g) AS easting_m, ST_Y(g) AS northing_m,
  ST_Distance(ST_Point(0, 0), ST_Point(0.004, 0)) AS degrees,
  ST_Distance_Spheroid(ST_Point(52.5, 13.4), ST_Point(52.5, 13.41)) AS geodesic_m
FROM projected
```

Dezfil geometry columns store longitude/latitude coordinates. The next example
flips those columns to latitude/longitude for spheroid distance. These Berlin
points are approximately 679 metres apart.

```sql
-- example: lonlat-spheroid
WITH places AS (
  SELECT id, ST_Point(lon, lat) AS geometry FROM (VALUES
    ('west', 13.4, 52.5), ('east', 13.41, 52.5)
  ) AS p(id, lon, lat)
)
SELECT ST_Distance_Spheroid(ST_FlipCoordinates(a.geometry), ST_FlipCoordinates(b.geometry)) AS geodesic_m
FROM places a, places b WHERE a.id = 'west' AND b.id = 'east'
```

Validity, emptiness and null are different facts. A null geometry is unknown;
SQL predicates on null usually yield null and a WHERE clause selects only true.
An empty geometry has no points. Check these properties when interpreting an
empty result. Aggregates such as count and sum answer different questions:
count counts records or non-null values, while sum combines measurements.

```sql
-- example: empty-null
SELECT ST_IsEmpty(ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')) AS empty,
       ST_IsValid(ST_GeomFromText('POLYGON ((0 0, 2 2, 0 2, 2 0, 0 0))')) AS valid,
       ST_Distance(ST_Point(0, 0), ST_GeomFromText(NULL)) AS unknown_distance,
       count(*) FILTER (WHERE ST_Intersects(ST_Point(0, 0), ST_GeomFromText(NULL))) AS matches
```

```sql
-- example: measurement
WITH shapes AS (
  SELECT ST_MakeEnvelope(0, 0, 100, 200) AS g
  UNION ALL SELECT ST_MakeEnvelope(0, 0, 100, 100)
)
SELECT count(*) AS records, sum(ST_Area(g)) AS total_m2,
       avg(ST_Area(g)) AS mean_m2,
       ST_Length(ST_GeomFromText('LINESTRING (0 0, 3 4)')) AS length_m
FROM shapes
```

The measurement example uses local metre coordinates. It totals 30,000 square
metres; the line length is 5 metres. Empty answers remain answers, as described
in [the shared analytical guidance](../analysis.md).

## Provenance

Adapted from GeoSQL `skills/geosql/SKILL.md` and
`skills/geosql/references/duckdb.md`, revision
`d2809ff65ca05b68fa423b61ad6e9f98f6d62cc6`, with executable examples for
Dezfil's locked DuckDB engine. Upstream: https://github.com/dekart-xyz/geosql.
Function semantics: https://duckdb.org/docs/current/core_extensions/spatial/functions.

MIT License

Copyright (c) 2026 dekart.xyz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
