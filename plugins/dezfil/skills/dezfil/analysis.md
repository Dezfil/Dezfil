# Working with Dezfil

<!-- Generated from src/lib/assistant/guidance.ts. -->

## account-connection

The client reads DEZFIL_API_TOKEN from its environment and sends it as an Authorization bearer. Calls use that account's current permissions. An authentication_required response means the client needs a current account token; forbidden means the account lacks the required permission. Credential configuration belongs to the client transport, outside tool arguments and task messages.

## ownership-and-sharing

Every map, dataset, workflow, connection and project has one owner and is private to its owner, administrators included, unless a project shares it: a project's owner gives people the viewer or editor role, and they reach the project and everything filed in it, whoever owns it. A viewer reads; an editor also changes the content of the project's maps and workflows, runs its workflows into their own datasets and files their own work there. Deleting, publishing, sharing and transferring stay with the owner, datasets change only by their owner, connections are never shared, and standalone job, download and render results stay with the account that started them. Listings name each item's owner, and each project the caller's role. An unreached resource is unavailable in the same way as a missing one, and a change the caller may not make answers forbidden. Every account has a SQL name. In SQL run directly, a plain table name is the caller's own dataset and <sql name>.<dataset> is another person's reachable dataset, the qualifiedName listings give; the same name can belong to different people. A map's or workflow's SQL reads in its SQL home, the space of the account that created it (its home): there a plain name is the home's dataset and anyone else's is qualified. Imports create named datasets for SQL. File readers, file-relation shorthand, path discovery and file-referencing PROJ definitions return sql_rejected regardless of path ownership or existence. Named datasets, qualified or dynamic named references and ordinary EPSG transforms remain supported. Saved SQL is retained unchanged, including queries that now fail this policy. Built-in and configured basemaps, palette and operation catalogues, reference catalogues and offered models are shared. Every authenticated account can create or delete a saved palette; a map's style and custom basemap belong to the map. A published token grants only its read-only projection, evaluated in the map's SQL home with its owner's reach and restricted to the datasets the map names. Deactivation freezes an account's work, its content read-only for everyone who reaches it, while existing publications stay readable; an admin can revoke a deactivated owner's known publication token without gaining access to the map.

## account-departures

A viewer or editor can leave a project, including a frozen one; only their grant ends and their owned work stays filed and shared. Owners transfer or dissolve instead. Another active admin can delete an account after separate deactivation. Deactivation keeps shared work; deletion permanently erases owned work, dissolves owned projects and breaks published links. Use the counts-only preview and its confirmation, confirm: true and the exact email for an ever-active account; an unredeemed invitation needs no typed email. Pending or needs-retry is unfinished: use status and Finish deleting with the same identifier, including after restart. A completed identifier becomes not_found. Finishing rewrites the metadata store and pauses all responses; an outside reader or insufficient space on the data or temporary filesystem can leave it unfinished and safe to retry. Except for invitations, all geocode, isochrone and Overpass answer caches are purged, so later calls reach providers again. The identifying SQL name stays reserved forever and SQL homes stay fixed. Historical last-change actors, Undo/Redo authors and run starters are { name, sqlName }, { deleted: true } for Deleted account, or null for Unknown. Deleted actors have no name or SQL-name label; ownership and times are separate. Others' derived datasets and stored SQL, lineage and run text remain. Runs whose workflow was already deleted have no remaining workflow owner and stay with a deleted starter. Issued private copies keep their existing lifetime; completion waits for prepared files to settle or expire and cleanup to finish. Recorded input evidence identifies affected derivatives, but others' existing unattributed card images remain. Backups, exports, downloaded files, host logs, providers, browser-local material and databases written through connections are outside deletion. Restores can revive data and credentials. This promises neither anonymization nor physical disk-remanence erasure.

## edit-revisions

Read a map or workflow and keep its editRevision with the state it describes. Covered tools require expected_revision; child writes use their parent's revision. Send covered writes to one document in order, waiting for each accepted result and using its returned editRevision for the next edit. Compound filing carries each selected document's revision in the documented members or resource input. Whole creation and copying to a new identity need no destination revision. Missing revisions return invalid_request; stale_revision changes nothing. After refusal, read again explicitly, inspect current state and compose a new edit. Never silently replay the refused payload with a fresh token. A token does not grant permission. Complete deletion has no resulting revision; a transfer may end your reach. Viewport-only saves, thumbnail capture and run cancellation are exceptions. Read shared undo targets and eligibility before replay; start runs with the revision returned by planning. Last-change actors and run initiators are separate from ownership; unknown historical authors stay unknown.

## candidate-filter

For a spatial question, apply a conservative candidate filter appropriate to the predicate, then the exact predicate; the filter must keep every exact match. For containment and intersection the candidate filter is a bounding-box overlap between the feature's box and the area's box, then ST_Intersects or ST_Within on the geometries. For a distance predicate (within N metres) the candidate filter is an envelope expanded by that distance in the geometry's units, then ST_DWithin on the geometries; a plain box overlap loses the matches the distance is for. The two cases a wrong filter loses are the feature that crosses the area's boundary and the nearby geometry whose box does not overlap the other's.

## units

Check magnitude, CRS, axis order and units before you report a number. A planar measurement on EPSG:4326 geometry is in degrees or square degrees and is never reported as metres. Metres for a distance and square metres for an area come from a projected calculation whose units you state, or from a geodesic one such as ST_Distance_Spheroid or ST_Area_Spheroid; say which you used, since a projection alone does not imply metres. Coordinates are longitude then latitude; a swapped pair lands in the wrong hemisphere. The spheroid functions read latitude first, so a stored geometry goes through ST_FlipCoordinates before them; unflipped they answer a plausible number that is not the distance.

## empty-results

An empty result is an answer: check it and report it as it is. Do not widen the question, loosen the filter or drop a condition to obtain rows; say what returned nothing and what you checked.

## cartography

Cartography inside Dezfil's layer contract: a layer is its SQL, a name and a style, with a viz of points (which draws points, lines and polygons by their geometry), hexbin, grid, heatmap, arc, line, icon or cluster. Pick the layer kind for the question: the geometry itself for positions, areas and choropleths, a hexbin or grid at a chosen cell size for density over an area, a heatmap for a smooth surface, arcs for pairs, lines for movement, clusters for many points at low zoom. Prefer high-density defaults: small point radii and thin strokes over clamped row limits and large symbols. Do not encode one variable twice, for example a fill and an outline colour from the same field. The channels are fill, outline (strokeBy), size (pointRadiusBy), width (strokeWidthBy) and label; opacity is for overlap, not for data. Choose the palette by the data's kind from the palette registry: a sequential palette (viridis, plasma, blues, greens, ylorrd) for a magnitude, a diverging one (rdbu, piyg, spectral) for a signed value around a midpoint, a qualitative one (uber_viz_qualitative, tab10, dark2, set3) for categories, at most 10 of them coloured distinctly; no rainbow ramp. Match the basemap to density: the dark basemap under dense points and flows, the light one under choropleths. Frame the camera where the insight reads, at the zoom where the pattern is visible.

## render-reading

When you are handed a rendered image of a map, read it as a map: name what is visible in it, the marks, the layers, the legend and the widgets you can see, and do not claim anything the image does not show. Say which map and which rendered state you are describing, by the identity the facts give. Compare what you see against what was asked for, and say where they agree and where they differ. Propose at most one change, and leave it for the person to decide.

## classification

Classify to suit the task and the distribution: quantile or natural breaks for a skewed distribution, equal intervals for an even one, a continuous ramp for a smooth field, categorical for names. Computed boundaries come back rounded; keep hand-set boundaries as round as computed ones. H3 stays the index for widgets and index workflows; the visual hexbin is a planar tessellation at any cell size, so an H3 resolution is not a cell size.

## external-grounding

Ground an external task in catalogue, schema and current-map reads: list_tables and inspect_table describe available data; get_map and get_layer describe the selected map and its editable SQL and style. list_layer_fields and get_field_stats supply a layer's field kinds, ranges and categories. The external client obtains this context through reads; its conversation supplies the task and chosen map.

## Provenance

Adapted from GeoSQL `skills/geosql/SKILL.md` and
`skills/geosql/references/map-styling.md`, revision
`d2809ff65ca05b68fa423b61ad6e9f98f6d62cc6`.
Upstream: https://github.com/dekart-xyz/geosql.

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
