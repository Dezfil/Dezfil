---
name: dezfil
description: Analyze spatial data and create, refine, style or publish maps on a Dezfil instance through its MCP tools. Use for Dezfil map tasks, spatial SQL and workflow diagnosis.
---

# Dezfil

Dezfil is a file-native spatial SQL map builder with server-side DuckDB.
Maps contain layers with editable SQL, style and legend settings. The connected
instance supplies the available tools and their live argument schemas. The
client requires an account token through DEZFIL_API_TOKEN; calls retain that
account's current permissions. See [connection setup](../../README.md).

Read [analysis.md](analysis.md) for the shared analytical guidance and external
grounding. For styling, read [cartography](references/cartography.md). For SQL,
read [DuckDB spatial](references/duckdb-spatial.md). These resources travel with
the installed package.

## Route the task

| Task | Operation examples |
|---|---|
| Discover tables and inspect their schema | `list_tables`, `inspect_table` |
| Read the selected map, layer SQL and fields | `get_map`, `get_layer`, `list_layer_fields`, `get_field_stats` |
| Answer a spatial question with read-only SQL | `run_sql` |
| Create a map and add or refine a SQL layer | `create_map`, `create_layer`, `update_layer`, `update_map` |
| Compute classification, size and legend text | `compute_fill`, `compute_scale`, `update_layer` |
| Inspect history and undo or redo the latest step | `get_history`, `undo_change`, `redo_change` |
| Observe a rendered map and open its retained image | `look_at_map`, `read_map_look_image` |
| Publish, read or revoke a view | `publish_map`, `view_published_map`, `unpublish_map` |
| Bring a file or URL into the catalogue | `upload_table`, `import_table_from_url` |
| Materialize an operation and follow its outcome | `list_operations`, `run_operation`, `get_operation_run` |
| Diagnose a workflow and its member outcomes | `get_recipe`, `list_recipe_runs`, `get_recipe_run` |

## Read the result

The structured result has `result` and `history`. Legacy text carries the same
body. A coded failure has `isError: true` and an error code in the result body.
Accepted work returns a run identity and queued or running state; the run read
supplies its eventual outcome. Acceptance alone says nothing about completion.

Binary metadata names the content entry holding the bytes: either native image
data or a JSON pointer into legacy text. The content location, media type and
size describe that result's bytes. A map check identifies the map, render and
captured state. Reading its retained image retrieves that render; subsequent
map edits are a different state.

Map edits can carry a change group. The returned history association identifies
the map and supplied group, including for a no-op. It does not assert a new
history step. Consecutive edits in a group form a step; undo and redo address
the latest step on a map, with availability from the history read. Publication
has its own lifecycle outside map-edit history.

The listing's confirmation metadata describes a policy, target, consequence and
the documented read that resolves the subject. It is advisory: the client owns
the decision and dispatches an approved action. Destructive, read-only,
idempotence and external-access hints describe effects independently of undo.
The task's requested publication decision belongs to the person; a published
view and a private draft are distinct states.
