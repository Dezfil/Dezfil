# Cartography in Dezfil

The layer choices, distribution-sensitive classification and palette families
are in [the generated analysis guidance](../analysis.md). This reference adds
the stored style and legend details used when applying those choices.

Compute a fill for the field, method, palette and class count, then merge that
paint into the layer style. `quantile`, `equal` and `natural` return a classed
paint whose breaks are the actual stored boundaries. `continuous` returns a
domain and color stops; a diverging continuous paint also has a center.
`categorical` assigns distinct colors to the ten most frequent non-null values,
with the fallback color for other values. Ties can change category order.

Quantitative example: use this SQL for a layer, compute `area_ha` with method
`equal`, palette `viridis`, classes 2, and save that fill. The boundary is 20.
Set `legendTitle` to `Park area`, `legendAttrs.fill` to `Area (ha)`, and
`legendLabels` to `Below 20 ha` and `20 ha and above`.

```sql
-- example: quantitative
SELECT area_ha, ST_Point(0, 0) AS geometry
FROM (VALUES (0), (10), (20), (30), (40)) AS facts(area_ha)
```

Categorical example: use method `categorical`, attribute `kind`, palette
`tab10`. Frequencies deliberately differ so the ten distinct classes are
`kind_1` through `kind_10`; `kind_11` uses the fallback. Keep class labels tied
to returned values. A custom final label can name the fallback `Other kinds`.

```sql
-- example: categorical
SELECT 'kind_' || i AS kind, ST_Point(0, 0) AS geometry
FROM range(1, 12) AS kinds(i), range(1, 13) AS copies(j)
WHERE j <= 12 - i
```

Legend controls are layer `inLegend`, `legendTitle`, `legendLabels` and
`legendAttrs`. The `inLegend` switch controls inclusion. For `legendAttrs`,
a string channel value supplies an explicit attribute label;
a null channel value hides that attribute line;
an omitted channel key or a null whole object restores automatic attribute names. At map level, `legendCorner` and `legendOrder` control position and arrangement. A hidden layer contributes no
visible marks; legend inclusion is its separate stored setting. Class labels
and units describe the styled field, and each label corresponds to the stored
color or scale it explains. Read back the layer and map after saving them.

Readability depends on the rendered map's scale, density, contrast and framing.
A stored palette and correct breaks establish the encoding; the map image
supplies evidence about whether that encoding reads clearly.

## Provenance

Adapted from GeoSQL `skills/geosql/SKILL.md` and
`skills/geosql/references/map-styling.md`, revision
`d2809ff65ca05b68fa423b61ad6e9f98f6d62cc6`, with Dezfil-specific style and
legend facts. Upstream: https://github.com/dekart-xyz/geosql.

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
