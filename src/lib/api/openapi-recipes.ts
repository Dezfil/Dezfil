import { CARRY_RULE, WRITTEN_IN_REF } from "./openapi-written-in";
import { FILING_DESTINATION } from "./openapi-project-access";
import { cascadeAccess } from "./openapi-cascade-access";
import { jobAccess } from "./openapi-job-access";
import { workflowAccess } from "./openapi-workflow-access";
import { ownedCreationOp } from "./openapi-owned-creation";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, LOCAL_REPLACE, WORKFLOW_RUN } from "./operation-mcp";
import { READ_ONLY, writes, resource, planning } from "./operation-metadata";
import { op, jsonOk, pathParam } from "./openapi-helpers";
import { WORKFLOW_JSON_BODY_MAX_BYTES } from "./request-bounds";
import { PROJECT_SCOPE_PARAM } from "./openapi-projects";

const WORKFLOW_JSON_BODY_BOUND =
  `**Request body bound.** At most ${WORKFLOW_JSON_BODY_MAX_BYTES.toLocaleString("en-US")} ` +
  "wire bytes; a larger body is refused with `request_body_too_large` before JSON parsing. " +
  "Ordinary maximum-shape layout documents fit; escape-inflated keys and unbounded note ids can exceed the outer byte bound and are refused by design.\n\n";

export const RECIPE_PATHS = {
  "/api/recipes": {
    get: op(workflowAccess({
      summary: "List recipes",
      description:
        "Every recipe the caller reaches (their own, and every one filed in a project they own or belong to), each with its steps and their " +
        "current conditions, what each step reads now, and a summary " +
        "of the whole (its status and counts). A recipe is a workspace " +
        "object like a dataset — not owned by a map, and outliving the " +
        "layer that prompted it. `origin` narrows the answer to the " +
        "workflows page's own (`workflow`) or the builder's one-step " +
        "recipes (`builder`); unfiltered, both answer.",
      tag: "Recipes",
      tool: "list_recipes", mcp: LOCAL_READ,
      display: {"verb": "Listed the workflows"},
      effects: READ_ONLY,
      parameters: [
        {
          name: "origin",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["workflow", "builder"] },
          description:
            "Which surface made the recipes wanted. Omitted, every recipe.",
        },
        PROJECT_SCOPE_PARAM,
      ],
      responses: { "200": jsonOk("#/components/schemas/RecipeList") },
    })),
    post: ownedCreationOp(workflowAccess({
      summary: "Create a recipe",
      description:
        WORKFLOW_JSON_BODY_BOUND +
        "A named, ordered list of steps. Dependencies may point only " +
        "backwards, which is what keeps it authorable as a list and " +
        "checkable without cycle detection at run time. The name is " +
        "trimmed, must not be empty, and is at most 120 characters; two " +
        "recipes may share one. `origin` says which surface is creating " +
        "it — `workflow` (the default) or `builder`, the one-step Tools' " +
        "invisible recipes — and never changes afterwards. Only " +
        "workflows can be project members.",
      tag: "Recipes",
      tool: "create_recipe", mcp: LOCAL_ADD,
      display: {"verb": "Created the workflow {subject}", "subject": {"resource": "recipes", "result": "recipe.id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "", "recipe.id"), resource("projects")),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string", maxLength: 120 },
                origin: { type: "string", enum: ["workflow", "builder"] },
                projectId: {
                  type: ["string", "null"],
                  description:
                    "The project the new workflow joins; " +
                    "omitted or null, it starts unfiled. An unknown " +
                    "project refuses and creates nothing. Builder-origin " +
                    "recipes are refused project membership." + FILING_DESTINATION,
                },
              },
              required: ["name"],
            },
            example: { name: "Accidents near schools" },
          },
        },
      },
      responses: {
        "201": jsonOk("#/components/schemas/RecipeEnvelope", "Created."),
      },
    })),
  },
  "/api/recipes/{id}": {
    get: op(workflowAccess({
      summary: "Read a recipe",
      description:
        "The recipe and every step in order, each with **all** the " +
        "conditions true of it — broken, output missing, stale, never " +
        "run, current — its stale causes with the input each came from, " +
        "and its latest attempt as an ordinary run. The condition and " +
        "the attempt are read together: fresh output with a failed " +
        "latest attempt is a real and common combination.",
      tag: "Recipes",
      tool: "get_recipe", mcp: LOCAL_READ,
      display: {"verb": "Read the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Recipe id.")],
      responses: { "200": jsonOk("#/components/schemas/RecipeEnvelope") },
    })),
    patch: op(workflowAccess({
      summary: "Rename a recipe",
      description:
        WORKFLOW_JSON_BODY_BOUND +
        "The same name rule as creation: trimmed, not empty, at most 120 " +
        "characters, shared names allowed. Renaming moves the recipe's " +
        "last-edited time, as adding, editing, reordering or removing a " +
        "step does; running it does not.",
      tag: "Recipes",
      tool: "update_recipe", mcp: LOCAL_REPLACE,
      display: {"verb": "Updated the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "id")),
      parameters: [pathParam("id", "Recipe id.")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      },
      responses: { "200": jsonOk("#/components/schemas/RecipeEnvelope") },
    })),
    delete: op(workflowAccess({
      summary: "Delete a recipe",
      description:
        "**The datasets its steps produced remain in the workspace.** A " +
        "recipe records how they were made; it does not own them. That " +
        "is what this confirmation is for — a user expecting the tables " +
        "to go with it has been told the wrong thing.",
      tag: "Recipes",
      tool: "delete_recipe", mcp: LOCAL_DELETE,
      display: {"verb": "Deleted the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
      effects: writes(resource("recipes", "id"), resource("projects")),
      confirmation: {"target": "Delete {target}?", "consequence": "This deletes the workflow. Its output datasets remain in the workspace.", "subject": {"path": "/api/recipes/{id}", "argument": "id", "name": "recipe.name"}},
      confirm: true,
      parameters: [pathParam("id", "Recipe id.")],
      responses: {
        "200": jsonOk("#/components/schemas/RecipeDeleted"),
      },
    })),
  },
  "/api/recipes/{id}/duplicate": {
    post: ownedCreationOp(workflowAccess({
      summary: "Duplicate a recipe",
      description:
        "A copy named \"<name> copy\", a workflow, that has never run: " +
        "the same steps in the same order under fresh ids, each from its " +
        "active definition (a pending edit is not carried) with its " +
        "layer provenance; every output renamed to a free name; every " +
        "read of an original output redirected to the copy's, in named " +
        "inputs and in SQL table references alike, with literals and " +
        "comments untouched. The original and its datasets are unchanged. " +
        "Refused (409) if the recipe changes while the copy is prepared, " +
        "and (422) if a step's SQL cannot be rewritten to read the copy's " +
        "outputs.",
      tag: "Recipes",
      tool: "duplicate_recipe", mcp: LOCAL_ADD,
      display: {"verb": "Duplicated a workflow as {subject}", "subject": {"resource": "recipes", "result": "recipe.id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "", "recipe.id"), resource("projects")),
      parameters: [pathParam("id", "Recipe id.")],
      responses: {
        "201": jsonOk("#/components/schemas/RecipeEnvelope", "Created."),
      },
    })),
  },
  "/api/recipes/{id}/dependencies": {
    get: op(workflowAccess({
      summary: "The datasets a workflow reads and writes",
      description:
        "Each step's references resolve to dataset identities in the workflow's SQL home within the caller's reach, the workflow's own outputs as the caller would run them, and each one is listed with its owner and the name the caller would type: a dataset the caller cannot reach is left out rather than named, and a same-named dataset of the caller's own never stands in for the home's. Memberships name the projects the caller reaches, and on the caller's own datasets every project they are in, one the caller no longer reaches included; producers only workflows the caller reaches, each marked with whether the caller owns it. " +
        "The filing checklist's subject for a workflow: " +
        "every registered dataset the workflow's current node " +
        "definitions read (a pending edit over the active one) and " +
        "every runner's recorded output of the workflow that the caller reaches, exactly " +
        "once — a dataset both read and written appears once — with " +
        "the same facts as a map's dependencies: source, row count, " +
        "project memberships, the producing workflow, geometry column " +
        "and sampled geometry type. A node whose definition cannot be " +
        "analyzed fails the whole read with `dependencies_unresolved`; " +
        "unlike the recipe read, which tolerates an unreadable node, " +
        "this read never answers partially.",
      tag: "Recipes",
      tool: "get_workflow_dependencies", mcp: LOCAL_READ,
      display: {"verb": "Read the datasets of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Recipe id.")],
      responses: {
        "200": jsonOk("#/components/schemas/WorkflowDependencies"),
      },
    })),
  },
  "/api/recipes/{id}/layout": {
    get: op(workflowAccess({
      summary: "Read a recipe's canvas layout",
      description:
        "The layout document: where each step and each " +
        "source sits on the canvas, and the notes written around them. " +
        "Stored beside the recipe, never inside it: nothing here changes " +
        "what a run does or what a step reads. A recipe never arranged " +
        "reads as the empty document with no write time. A read never " +
        "names a step the recipe no longer has.",
      tag: "Recipes",
      tool: "get_recipe_layout", mcp: LOCAL_READ,
      display: {"verb": "Read the layout of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Recipe id.")],
      responses: { "200": jsonOk("#/components/schemas/RecipeLayoutEnvelope") },
    })),
    put: op(workflowAccess({
      summary: "Replace a recipe's canvas layout",
      description:
        WORKFLOW_JSON_BODY_BOUND +
        "Replaces the whole document and answers with it as stored; " +
        "there is no partial update, and `{}` is the empty document. A " +
        "position for a step id the recipe does not have is dropped, " +
        "not refused. Anything else wrong (a position that is not two " +
        "finite numbers, more than 1,000 step positions, more than 1,000 " +
        "source positions, a step or source key past 1,000 characters, " +
        "a note missing a field, a colour outside the six, text past " +
        "4,000 characters, a non-positive size, a blank or duplicated " +
        "note id, more than 100 notes) is refused whole (400) naming " +
        "the first fault, and nothing is stored. A write that changes " +
        "the document moves the recipe's last-edited time; one that " +
        "stores what was already stored does not. Last write wins.",
      tag: "Recipes",
      tool: "set_recipe_layout", mcp: LOCAL_REPLACE,
      display: {"verb": "Arranged the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
      effects: writes(resource("recipes", "id")),
      parameters: [pathParam("id", "Recipe id.")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RecipeLayoutInput" },
          },
        },
      },
      responses: { "200": jsonOk("#/components/schemas/RecipeLayoutEnvelope") },
    })),
  },
  "/api/recipes/{id}/steps": {
    post: op(workflowAccess({
      summary: "Add a step",
      description:
        WORKFLOW_JSON_BODY_BOUND +
        "Appends a step naming an operation from the catalog, its " +
        "parameters, and the dataset it will produce.\n\n" +
        "**The output's name**: stored in the registry's " +
        "form; a blank or letterless name is refused in its own words; " +
        "a name a registered table carries, or another step of this " +
        "recipe declares or holds, is refused (`name_taken`) naming the " +
        "holder. Another recipe's unrun declaration is no reservation. " +
        "A step may be added unnamed; the run refuses a nameless one. " +
        "**SQL the parser cannot read is accepted** with no present " +
        "reads; the dry run and the run refuse it and say why.\n\n" +
        "Give `fromLayerId` to author it from a layer: the step takes " +
        "that layer's SQL **refined by its filters**, captured now and " +
        "never re-read, so the step stays reproducible when the filters " +
        "later change. Where the layer is drawn as hex bins, grid cells " +
        "or origin–destination lines, the step consumes the **rows " +
        "behind** those cells rather than the cells themselves, and the " +
        "answer says so in `origin.substitutionNote`. Any layer the " +
        "caller reaches can be captured, its SQL carried from its map's " +
        "home into this workflow's context; one the caller does not " +
        "reach answers as a missing one.\n\n" +
        "Give `writtenIn` when the parameters were written elsewhere " +
        "(a node copied from another workflow, the caller's console, a " +
        "map): their dataset inputs and SQL are carried into this " +
        "workflow's context, where this step's own output already takes " +
        "its name. " + CARRY_RULE + "\n\n" +
        "A step that would read its own output, or a later step's, is " +
        "refused here rather than at run time.",
      tag: "Recipes",
      tool: "add_recipe_step", mcp: LOCAL_ADD,
      display: {"verb": "Added a step to the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "id")),
      parameters: [pathParam("id", "Recipe id.")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                operation: {
                  type: "string",
                  description: "An operation id from the catalog.",
                },
                parameters: {
                  type: "object",
                  description:
                    "The operation's own parameters, as the catalog " +
                    "describes them — including non-scalar ones, which " +
                    "are kept as sent.",
                },
                fromLayerId: {
                  type: "string",
                  description:
                    "Author from this layer: its filtered SQL is " +
                    "captured into the step's `sql` parameter, carried " +
                    "from the layer's map into this workflow.",
                },
                writtenIn: {
                  ...WRITTEN_IN_REF,
                  description:
                    "Where `parameters` were written, when not in this " +
                    "workflow; they are carried into it.",
                },
              },
              required: ["operation"],
            },
            example: {
              operation: "spatial_join",
              parameters: {
                left: "boroughs",
                right: "accidents",
                predicate: "contains",
                carry: [{ aggregate: "count" }],
                name: "boroughs_with_accidents",
              },
            },
          },
        },
      },
      responses: {
        "201": jsonOk("#/components/schemas/RecipeStepEnvelope", "Created."),
      },
    })),
  },
  "/api/recipes/{id}/steps/{stepId}": {
    get: op(workflowAccess({
      summary: "Read a step",
      description:
        "One step's definition, condition, stale causes, recorded " +
        "inputs and latest attempt.",
      tag: "Recipes",
      tool: "get_recipe_step", mcp: LOCAL_READ,
      display: {"verb": "Read a step of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [
        pathParam("id", "Recipe id."),
        pathParam("stepId", "Step id."),
      ],
      responses: {
        "200": jsonOk("#/components/schemas/RecipeStepEnvelope"),
      },
    })),
    patch: op(workflowAccess({
      summary: "Edit a step",
      description:
        WORKFLOW_JSON_BODY_BOUND +
        "**A change to a step that has already produced something is a " +
        "proposal.** The step keeps meaning what its output was produced " +
        "from until a run of the proposal succeeds; `applied` says which " +
        "of the two happened — `active` for a step that had produced " +
        "nothing, `proposed` otherwise. An edit that puts the active " +
        "definition back clears the pending one and answers `active`" +
        ".\n\n" +
        "**Reading a later step's output orders the recipe rather than " +
        "refusing**: the reader and everything depending on it move after " +
        "the producer, other steps keep their places, the whole order is " +
        "checked, and the edit and the order land together or not at " +
        "all; a self-read is refused. **A produced output's name is " +
        "frozen**; before the first run the name rule of adding applies. " +
        "**SQL the parser cannot read is accepted** with no present " +
        "reads. Refused (409) if the recipe changed while the edit was " +
        "checked.",
      tag: "Recipes",
      tool: "update_recipe_step", mcp: LOCAL_REPLACE,
      display: {"verb": "Edited a step of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "id")),
      parameters: [
        pathParam("id", "Recipe id."),
        pathParam("stepId", "Step id."),
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                parameters: { type: "object" },
                fromLayerId: {
                  type: "string",
                  description:
                    "Re-author from this layer, any the caller reaches: " +
                    "its filtered SQL is captured and carried from its " +
                    "map into this workflow.",
                },
                writtenIn: {
                  ...WRITTEN_IN_REF,
                  description:
                    "Where `parameters` were written, when not in this " +
                    "workflow; they are carried into it as an add's are.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonOk("#/components/schemas/RecipeStepEdited"),
      },
    })),
    delete: op(workflowAccess({
      summary: "Remove a step",
      description:
        "The step detaches: **the dataset it produced and its run " +
        "history both survive**, and a step that reads that dataset goes " +
        "on reading it as an ordinary workspace table. The answer says " +
        "what is true: whether that dataset `exists`, was " +
        "`deleted` since, or `never` was, and which steps read its name.",
      tag: "Recipes",
      tool: "remove_recipe_step", mcp: LOCAL_DELETE,
      display: {"verb": "Removed a step from the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "id")),
      confirmation: {"target": "Remove {target}?", "consequence": "This removes the node from its workflow. Existing output datasets and run history remain.", "subject": {"path": "/api/recipes/{id}/steps/{stepId}", "argument": "stepId", "name": "step.parameters.name"}},
      confirm: true,
      parameters: [
        pathParam("id", "Recipe id."),
        pathParam("stepId", "Step id."),
      ],
      responses: {
        "200": jsonOk("#/components/schemas/RecipeStepRemoved"),
      },
    })),
  },
  "/api/recipes/{id}/steps/{stepId}/proposal": {
    delete: op(workflowAccess({
      summary: "Discard a step's pending edit",
      description:
        "Puts the step back to its active definition — what its output " +
        "was produced from — and changes nothing else. A step " +
        "holding no pending edit is unchanged, and `discarded` says so.",
      tag: "Recipes",
      tool: "discard_recipe_step_edit", mcp: LOCAL_REPLACE,
      display: {"verb": "Discarded a step's pending edit on the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "id")),
      parameters: [
        pathParam("id", "Recipe id."),
        pathParam("stepId", "Step id."),
      ],
      responses: {
        "200": jsonOk("#/components/schemas/RecipeStepDiscarded"),
      },
    })),
  },
  "/api/recipes/{id}/steps/{stepId}/move": {
    post: op(workflowAccess({
      summary: "Reorder a step",
      description:
        WORKFLOW_JSON_BODY_BOUND +
        "Moves the step to a position, rewriting the ordinals densely. " +
        "**The whole proposed ordering is checked**, not just the step " +
        "that moved: dragging a producer downwards breaks its consumers " +
        "rather than itself, and a reorder that would leave the recipe " +
        "invalid is refused with nothing changed.",
      tag: "Recipes",
      tool: "move_recipe_step", mcp: LOCAL_REPLACE,
      display: {"verb": "Moved a step of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "id")),
      parameters: [
        pathParam("id", "Recipe id."),
        pathParam("stepId", "Step id."),
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                ordinal: {
                  type: "integer",
                  description: "Zero-based position to move it to.",
                },
              },
              required: ["ordinal"],
            },
          },
        },
      },
      responses: { "200": jsonOk("#/components/schemas/RecipeEnvelope") },
    })),
  },
  "/api/recipes/{id}/steps/{stepId}/run": {
    post: ownedCreationOp(cascadeAccess({
      summary: "Run one step",
      description:
        "Answers **202** with one of the recipe's runs: a " +
        "run of kind `single` with this one member, listed among the " +
        "recipe's runs and read and cancelled through them; poll " +
        "`/api/recipes/{id}/runs/{runId}` for its outcome. **This runs " +
        "the step and nothing else** — carrying its dependents is the " +
        "recipe-run endpoint's job.\n\n" +
        "A re-run replaces the same runner's earlier output of the step " +
        "**in place**, keeping the dataset's id and name, so every layer " +
        "built on it keeps pointing at fresh data with no re-wiring; " +
        "another runner's output is never touched. A failed re-run " +
        "leaves the previous output intact and queryable.\n\n" +
        "**What a caller may rely on.** The recipe's one-run-at-a-time " +
        "rule applies: while a run is in flight this answers **409 " +
        "`run_in_flight`** naming it. Ordinarily, a step the API cannot " +
        "admit alone is refused before anything exists: no run, no " +
        "attempt. Narrow exception: if the run was already listable and " +
        "cancellation was accepted before that refusal, the cancelled " +
        "run remains with the refusal member and no attempt. The run " +
        "stays with the recipe after the step is removed.",
      tag: "Recipes",
      tool: "run_recipe_step", mcp: WORKFLOW_RUN,
      display: {"verb": "Ran a step of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "id"), resource("runs", "", "run.id"), resource("tables")),
      parameters: [
        pathParam("id", "Recipe id."),
        pathParam("stepId", "Step id."),
      ],
      responses: {
        "202": jsonOk(
          "#/components/schemas/RecipeRunEnvelope",
          "Accepted; poll the recipe run for its outcome.",
        ),
        "409": {
          description: "A run is already in flight (`run_in_flight`, naming it); nothing started.",
        },
      },
    })),
  },
  "/api/recipes/{id}/runs": {
    get: op(cascadeAccess({
      summary: "List a recipe's runs",
      description:
        "Every cascade this recipe has had, newest first, each durable " +
        "and readable long after it finished.",
      tag: "Recipes",
      tool: "list_recipe_runs", mcp: LOCAL_READ,
      display: {"verb": "Listed the runs of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Recipe id.")],
      responses: { "200": jsonOk("#/components/schemas/RecipeRunList") },
    })),
    post: ownedCreationOp(cascadeAccess({
      summary: "Run a recipe, or a step and its dependents",
      description:
        WORKFLOW_JSON_BODY_BOUND +
        "Omit `fromStepId` to run the whole recipe from the beginning; " +
        "give one to re-run that step and everything that reads it, in " +
        "dependency order. A step starts only once every step it reads " +
        "has succeeded, and one whose dependency failed is **not " +
        "attempted** — reported `not_run`, minting no run at all, with " +
        "the failure that stopped it named. Steps that do not depend on " +
        "the failure still run.\n\n" +
        "**Ask first with `plan: true`.** It answers what the request " +
        "would carry without starting anything: `wide` is true for a run " +
        "of the whole recipe and for a re-run that carries dependents, " +
        "and false for the same request aimed at a step nothing reads. " +
        "That is what the `when_wide` confirmation on this operation " +
        "means — confirm the wide cases, not the leaf.\n\n" +
        "A recipe run is **not** an operation run: it answers **202** " +
        "with its own resource, which has its own outcome and contains " +
        "the members' ordinary runs.\n\n" +
        "**What a caller may rely on.** A recipe runs one " +
        "run at a time: a start while one is in flight — this operation's " +
        "or a single step's — answers **409 `run_in_flight`** naming the " +
        "run, and two starts that race yield one run and one refusal. " +
        "A start that names `members` — the step ids a confirmation " +
        "listed, in order — starts exactly when the plan at start is " +
        "that set in that order, and answers **409 `plan_changed`** " +
        "otherwise, nothing started; the binding is membership and " +
        "order only, never a member's definition, which is read when " +
        "the member is admitted. Each attempted member's record carries " +
        "its attempt — state, error, times, output — kept with the run " +
        "after the step's own history is pruned; a member never " +
        "attempted has none; every member keeps its step's operation " +
        "and name after the step is removed.",
      tag: "Recipes",
      tool: "run_recipe", mcp: WORKFLOW_RUN,
      display: {"verb": "Ran the workflow {subject}", "planningVerb": "Planned the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: planning("plan", writes(resource("recipes", "id"), resource("runs", "", "run.id"), resource("tables"))),
      confirmation: {"target": "Run {target}?", "consequence": "This runs the listed nodes in order and creates or replaces their output datasets.", "subject": {"path": "/api/recipes/{id}", "argument": "id", "name": "recipe.name"}},
      confirm: "when_wide",
      parameters: [pathParam("id", "Recipe id.")],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                fromStepId: {
                  type: "string",
                  description:
                    "Re-run this step and its dependents. Omitted, the " +
                    "whole recipe runs.",
                },
                plan: {
                  type: "boolean",
                  description:
                    "Report what would be carried, and whether that is " +
                    "wide, without starting anything.",
                },
                members: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The step ids a confirmation listed, in order. Given, " +
                    "the run starts only when the plan at start is exactly " +
                    "that set in that order; otherwise 409 `plan_changed`.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonOk(
          "#/components/schemas/RecipeRunPlan",
          "What this would carry; nothing started.",
        ),
        "202": jsonOk(
          "#/components/schemas/RecipeRunEnvelope",
          "Accepted; poll the recipe run for its outcome.",
        ),
        "409": {
          description:
            "A run is already in flight (`run_in_flight`, naming it), or " +
            "the plan no longer matches the confirmed `members` " +
            "(`plan_changed`); nothing started.",
        },
      },
    })),
  },
  "/api/recipes/{id}/runs/{runId}": {
    get: op(cascadeAccess({
      summary: "Read a recipe run",
      description:
        "Its own outcome — completed, partly completed, failed, " +
        "cancelled or interrupted — every member with what became of it, " +
        "and every dataset it produced. A member reported `not_run` " +
        "carries **no** run id, because nothing was minted for it.",
      tag: "Recipes",
      tool: "get_recipe_run", mcp: LOCAL_READ,
      display: {"verb": "Read a run of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [
        pathParam("id", "Recipe id."),
        pathParam("runId", "Recipe run id."),
      ],
      responses: { "200": jsonOk("#/components/schemas/RecipeRunEnvelope") },
    })),
  },
  "/api/recipes/{id}/runs/{runId}/cancel": {
    post: op(jobAccess(cascadeAccess({
      summary: "Cancel a recipe run",
      description:
        "One thing to stop, whatever it was in the middle of: what has " +
        "not started never starts. Every member found running when " +
        "cancellation is accepted is cancelled before any member " +
        "settlement is awaited; only a member already terminal at " +
        "acceptance stays finished, and its output stands. Running " +
        "members are interrupted **in the engine**, not only in the " +
        "record. The run's own " +
        "outcome is then `cancelled`, written once the last in-flight " +
        "member has settled. Cancelling one that has already finished " +
        "is not an error.",
      tag: "Recipes",
      tool: "cancel_recipe_run", mcp: LOCAL_REPLACE,
      display: {"verb": "Cancelled a run of the workflow {subject}", "subject": {"resource": "recipes", "argument": "id", "name": ["recipe.name", "name"]}},
      effects: writes(resource("recipes", "id"), resource("runs", "runId")),
      parameters: [
        pathParam("id", "Recipe id."),
        pathParam("runId", "Recipe run id."),
      ],
      responses: {
        "200": jsonOk("#/components/schemas/RecipeRunEnvelope"),
        "204": {
          description:
            "Cancelled for its initiator, who no longer reaches the " +
            "workflow: the run is not shown.",
        },
      },
    }))),
  },
};
