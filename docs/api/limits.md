---
title: "SQL result limits"
summary: "The fixed byte ceilings on SQL answers, dataset inspection and previews, and what is refused, shortened or still streamed in full."
read_when:
  - "a query or an inspection answers query_result_too_large"
  - "you need to know which reads are bounded and by how much"
audience:
  - user
  - developer
  - agent
checked: none
moved_from:
  - "/docs/reference/sql-limits/"
---

SQL console/SQL previews, dataset inspection, geometry-choice preview and the
PostGIS five-row preview have fixed result limits: **33,554,432 bytes (32 MiB)**
for the complete uncompressed UTF-8 JSON answer and **2,097,152 bytes (2 MiB)**
for one non-geometry column value. Equality is admitted. Quotes, escaping,
nested values, schema, repeated keys and metadata count after existing display
conversions and excerpts. Native geometry, identified by type or registered
provenance before conversion, counts only toward the result ceiling; coordinate
text and JSON remain non-geometry. Exceeding either bound refuses the whole
answer with HTTP 422 `query_result_too_large`, without partial data or details:

> The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.

These ceilings have no setting. Row and engine-memory limits still apply;
a result below both byte ceilings can fail the engine-memory limit during
query execution or result projection, including geometry decoding. Layer
renders, dataset map features, slider and Overture previews and published
views retain their existing limits. A filter's distinct values, categorical
classification, category widgets and value search hold each text value they
return to the 2 MiB value ceiling: the first two refuse with the same 422, a
category widget answers that code as its own error while the others keep
working, and value search names the layer under `refusedLayers` and answers no
rows from it, which the builder's search says in a line under its results. SQL, table and layer file exports still stream complete
results above both ceilings. Dataset inspection shows text values, and the WKT
of its registered geometry column, longer than 512 characters as their first
512 characters and an ellipsis, as geometry-choice preview does. Other values,
nested values, additional geometry columns, the schema, row counts and the
stored data stay whole, and SQL console/SQL previews and the PostGIS preview do
not excerpt, so long text alone no longer refuses an inspection. An inspection that still exceeds a
ceiling, with a nested value over 2 MiB for example, prevents its detail and docked set-geometry
panel from opening. It also blocks tool column pickers, SQL schema inventory
and completion, workflow dataset reads and facts, and automatic layer addition
after a tool run. The tool run can report failure even though the dataset has
already been written. Existing layer rendering, dataset map features, complete
API file exports and owner deletion from Data use separate reads and remain
available. This bounds serialized data on the covered reads,
not native chunks, JavaScript object overhead, heap or RSS.
