import { describe, expect, it } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { admits, admittedTools, policyFor } from "./policy";

describe("the page action policy", () => {
  it("derives the policy from the context's page: full for the builder and no context, read-only for /sql and workflow", () => {
    expect(policyFor(undefined)).toBe("full");
    expect(policyFor({ page: "builder", mapId: "m", selectedLayerId: null })).toBe("full");
    expect(policyFor({ page: "sql", draft: "", selection: null, lastExecution: null })).toBe("read_only");
    expect(policyFor({ page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null })).toBe("read_only");
  });

  it("the full policy offers every generated tool unchanged", () => {
    const tools = buildTools();
    expect(admittedTools("full", tools)).toBe(tools);
  });

  it("the read-only policy admits exactly the unconditional read-only operations", () => {
    const tools = buildTools();
    const admitted = admittedTools("read_only", tools);
    const names = admitted.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["run_sql", "read_table_catalogue", "get_map"]));
    expect(names).not.toContain("update_map");
    for (const tool of admitted) {
      expect(tool.effects.readOnly, tool.name).toBe(true);
      expect(tool.effects.writes, tool.name).toEqual([]);
      expect(tool.effects.planningArgument, tool.name).toBeUndefined();
      expect(tool.confirm, tool.name).toBe(false);
      expect(tool.confirmWhen, tool.name).toBeUndefined();
    }
    // Every excluded tool declares a write on some argument, a planning form,
    // that it reaches outside this server, or that it asks for confirmation.
    for (const tool of tools) {
      if (names.includes(tool.name)) continue;
      expect(!tool.effects.readOnly || tool.effects.planningArgument !== undefined || tool.effects.reachesOutside === true ||
        tool.confirm || tool.confirmWhen !== undefined, tool.name).toBe(true);
    }
    // The registry holds conditional operations, one that reaches outside and
    // read-only ones that ask first, so each exclusion is exercised, not vacuous.
    expect(tools.some((t) => t.effects.planningArgument !== undefined)).toBe(true);
    expect(tools.filter((t) => t.effects.reachesOutside).map((t) => t.name).sort()).toEqual(["refresh_templates", "test_service"]);
    expect(names).not.toContain("test_service");
    expect(names).not.toContain("refresh_templates");
    expect(tools.filter((t) => t.effects.readOnly && !t.effects.reachesOutside && t.confirm).map((t) => t.name).sort()).toEqual(["read_storage", "test_part"]);
    expect(names).not.toContain("test_part");
    expect(names).not.toContain("read_storage");
  });

  /**
   * The operations the SQL and workflow assistants are offered, by name,
   * as a fixed list rather than a rule: a change to the rule that adds or
   * removes an operation shows here as that operation's name. A new
   * read-only operation lands in this list on purpose, or is named among
   * those refused below.
   */
  it("admits exactly the pinned operations under the read-only policy", () => {
    const names = admittedTools("read_only", buildTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      "check_health", "compute_fill", "compute_scale", "export_layer_data", "export_map_image", "export_project",
      "export_sql_result", "find_accounts", "get_account", "get_api_description", "get_config", "get_field_stats",
      "get_history", "get_instance_settings", "get_layer", "get_map", "get_map_dependencies", "get_operation_run",
      "get_project", "get_project_members", "get_publication_state", "get_published_fields", "get_recipe",
      "get_recipe_layout", "get_recipe_run", "get_recipe_step", "get_settings", "get_sketch_features",
      "get_table_features", "get_template", "get_user_deletion", "get_workflow_dependencies", "inspect_basemap_style",
      "inspect_table_geometry", "layer_extent", "list_api_tokens", "list_geometry_projections", "list_layer_fields",
      "list_layers", "list_map_sketches", "list_maps", "list_operation_runs", "list_operations",
      "list_overture_countries", "list_overture_division_levels", "list_overture_releases", "list_overture_states",
      "list_palettes", "list_postgis_connections", "list_postgis_snapshots", "list_postgis_tables",
      "list_project_people", "list_projects", "list_recipe_runs", "list_recipes", "list_tables", "list_templates", "list_users",
      "look_at_map", "preview_overture_import", "preview_postgis_relation", "preview_table_geometry",
      "preview_user_deletion", "published_layer_extent", "read_account_picture", "read_map_look_image", "read_table_catalogue",
      "read_widget_values", "render_layer", "run_osm_query", "run_overture_query", "run_sql", "sanitize_icon_svg",
      "search_map", "search_overture_divisions", "view_published_map",
    ]);
    // Read-only operations the policy refuses all the same, each for a
    // declared reason.
    const refused = buildTools().filter((t) => t.effects.readOnly && !names.includes(t.name)).map((t) => t.name).sort();
    expect(refused).toEqual(["read_storage", "refresh_templates", "test_part", "test_service"]);
  });

  it("admits answers per tool the way the set is built", () => {
    const tools = buildTools();
    for (const tool of tools) {
      expect(admits("read_only", tool)).toBe(admittedTools("read_only", tools).includes(tool));
      expect(admits("full", tool)).toBe(true);
    }
  });
});
