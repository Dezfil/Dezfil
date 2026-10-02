export const RECIPE_DEPENDENCY_SCHEMAS = {
  WorkflowDependencies: {
    type: "object",
    properties: {
      datasets: {
        type: "array",
        description:
          "The distinct registered datasets the workflow reads and " +
          "writes, every runner's recorded output the caller reaches " +
          "included, alphabetical by the name the caller would type.",
        items: { $ref: "#/components/schemas/DependencyDataset" },
      },
    },
    required: ["datasets"],
  },
};

export const RECIPE_SCHEMAS = {
  StaleCause: {
    type: "object",
    description:
      "Why a step's output no longer reflects what it was made from. " +
      "**Every active cause is reported**, each naming the input it " +
      "came from: a step can read a refreshed table *and* sit " +
      "downstream of a re-run step at once, and discarding one to " +
      "show the other would leave this unable to say why.",
    properties: {
      reason: {
        type: "string",
        enum: ["source_changed", "upstream_stale", "upstream_re_ran"],
      },
      tableId: { type: "string" },
      tableName: { type: "string" },
      producedByStepId: {
        type: "string",
        description: "The step that produces that table, when one does.",
      },
    },
  },
  RecipeStep: {
    type: "object",
    properties: {
      id: { type: "string" },
      recipeId: { type: "string" },
      ordinal: { type: "integer" },
      operation: { type: "string" },
      parameters: {
        type: "object",
        description:
          "What the step means now — what its output was produced " +
          "from. Non-scalar parameters are kept as sent.",
      },
      summary: {
        type: "string",
        description:
          "One line describing what this step does, composed from the " +
          "operation and its active parameters — \"500 m around " +
          "stations\". Served so every surface and every agent reads " +
          "the same sentence rather than composing its own; it " +
          "describes what the step means now, never a proposal " +
          "awaiting a run.",
      },
      proposedParameters: {
        type: ["object", "null"],
        description:
          "An edit awaiting a successful run; null when there is none.",
      },
      output: {
        type: ["object", "null"],
        description:
          "The output of the run this view describes: the caller's own " +
          "latest output of the step when they have one, else the " +
          "workflow owner's, each runner's output being their own " +
          "dataset. The step's conditions, inputs and last success " +
          "describe the same run. Shown when the caller reaches the " +
          "dataset; one since deleted only to its runner and the " +
          "workflow's owner. Null when neither has produced one or the " +
          "caller does not reach it.",
        properties: {
          id: { type: "string" },
          name: { type: ["string", "null"] },
          runner: {
            $ref: "#/components/schemas/ResourceOwner",
            description: "The person whose run produced it.",
          },
          runId: { type: ["string", "null"], description: "The workflow run that produced it, when recorded." },
          jobId: { type: ["string", "null"], description: "The step's attempt that produced it, when recorded." },
        },
      },
      condition: {
        type: "string",
        enum: ["broken", "output_missing", "stale", "never_run", "current"],
        description:
          "The first condition true of it, in the order broken, " +
          "output missing, stale, never run, current — un-runnable " +
          "before un-current, because offering a re-run that cannot " +
          "succeed tells the user the wrong thing.",
      },
      conditions: {
        type: "array",
        items: { type: "string" },
        description:
          "**Every** condition true of it. Conditions coexist: a step " +
          "can have lost both an input and its output.",
      },
      causes: {
        type: "array",
        items: { $ref: "#/components/schemas/StaleCause" },
      },
      missingInputs: {
        type: "array",
        description:
          "What it lost, when it is broken — with the id and name it " +
          "recorded, which is how the row explains itself after a " +
          "deletion. `throughStepId` is set when the break arrived " +
          "from a producer upstream rather than from this step's own " +
          "input. Conditions are read within the caller's reach: an " +
          "input the caller cannot reach is missing to them, named as " +
          "written, and for a caller whose own space is not the " +
          "workflow's SQL home it carries `message`, the sentence a " +
          "resource evaluation gives, the same for a hidden and a " +
          "nonexistent dataset.",
        items: {
          type: "object",
          properties: {
            tableId: { type: "string" },
            tableName: { type: "string" },
            throughStepId: { type: "string" },
            message: { type: "string" },
          },
        },
      },
      origin: {
        type: ["object", "null"],
        description:
          "Where a layer-authored step's SQL came from, including " +
          "`substitutionNote` when the layer aggregated and the step " +
          "took the rows behind the cells instead. The map and layer " +
          "it names are left out when the caller does not reach that map.",
      },
      inputs: {
        type: "array",
        description:
          "The tables this step read when it last published — from " +
          "the parse of the SQL that ran, never a scan of its text. " +
          "Only the ones the caller reaches, and, to the workflow's " +
          "owner, ones since deleted.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
      reads: {
        type: "array",
        items: { type: "string" },
        description:
          "What the step would read on its next run: its pending " +
          "definition's reads when it holds one, its active definition's " +
          "otherwise — named inputs, or the tables its SQL names — " +
          "before any run and whether or not those tables exist. " +
          "Present tense; `inputs` is the recorded past.",
      },
      latestAttempt: {
        oneOf: [
          { $ref: "#/components/schemas/OperationRun" },
          { type: "null" },
        ],
        description:
          "Its most recent run, in one of the five job states. Read " +
          "together with the condition and never instead of it.",
      },
      lastSuccessAt: { type: ["string", "null"] },
    },
  },
  Recipe: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      origin: {
        type: "string",
        enum: ["workflow", "builder"],
        description:
          "Which surface made it: the workflows page lists `workflow`; " +
          "the builder's one-step Tools make `builder`. Fixed at creation.",
      },
      projectId: {
        type: ["string", "null"],
        description:
          "The project this workflow is in: on the caller's own " +
          "workflow always, a project they no longer reach included " +
          "(they withdraw it with PATCH /api/projects/{id}/members), " +
          "and on anyone else's the project through which the caller " +
          "reaches it; null = in no project.",
      },
      owner: {
        $ref: "#/components/schemas/ResourceOwner",
        description: "The workflow's owner.",
      },
      home: {
        type: "string",
        description:
          "The SQL name of the workflow's SQL home: the account whose " +
          "datasets its plain table names mean, whoever reads or runs it.",
      },
      createdAt: { type: "string" },
      updatedAt: {
        type: "string",
        description:
          "When it was last edited: rename, or a step added, edited, " +
          "reordered or removed. A run is not an edit, and neither is " +
          "a refused change. Strictly increasing.",
      },
      summary: { $ref: "#/components/schemas/RecipeSummary" },
      steps: {
        type: "array",
        items: { $ref: "#/components/schemas/RecipeStep" },
      },
    },
    required: ["owner", "home"],
  },
  RecipeSummary: {
    type: "object",
    description:
      "The recipe's one-line state, computed by the server so the " +
      "workflows page and an agent read the same classification. The " +
      "first status that applies wins; a step in more than one " +
      "condition counts once, in the status shown.",
    properties: {
      nodes: { type: "integer", description: "Steps in the recipe." },
      sources: {
        type: "integer",
        description:
          "Distinct tables read that no step of this recipe produces.",
      },
      liveOutputs: {
        type: "integer",
        description:
          "Outputs whose dataset currently exists — what deleting the " +
          "recipe leaves behind.",
      },
      status: {
        type: "string",
        enum: [
          "empty",
          "cannot_run",
          "in_progress",
          "failed",
          "run_again",
          "never_run",
          "partly_never_run",
          "up_to_date",
        ],
        description:
          "In precedence: `empty` (no steps); `cannot_run` (a step is " +
          "broken); `in_progress` (a latest attempt queued or running); " +
          "`failed` (a latest attempt failed); `run_again` (an output " +
          "deleted or stale, or a pending edit); `never_run` (no step " +
          "has an output); `partly_never_run` (some have none); " +
          "`up_to_date`. A cancelled attempt alone changes nothing.",
      },
      count: {
        type: "integer",
        description:
          "How many steps the status counts; 0 for empty and up to date.",
      },
    },
  },
  RecipeEnvelope: {
    type: "object",
    properties: { recipe: { $ref: "#/components/schemas/Recipe" } },
  },
  RecipeList: {
    type: "object",
    properties: {
      recipes: {
        type: "array",
        items: { $ref: "#/components/schemas/Recipe" },
      },
    },
  },
  RecipeStepEnvelope: {
    type: "object",
    properties: { step: { $ref: "#/components/schemas/RecipeStep" } },
  },
  RecipeStepEdited: {
    type: "object",
    properties: {
      step: { $ref: "#/components/schemas/RecipeStep" },
      applied: {
        type: "string",
        enum: ["active", "proposed"],
        description:
          "`active` changed what the step means; `proposed` is " +
          "waiting on a successful run of it.",
      },
    },
  },
  RecipeStepRemoved: {
    type: "object",
    properties: {
      removed: { type: "string" },
      output: {
        type: ["object", "null"],
        description: "The step's output, by its recorded identity; null for a step that declared none.",
        properties: {
          name: { type: "string" },
          state: {
            type: "string",
            enum: ["exists", "deleted", "never"],
            description:
              "`exists`: the dataset remains; `deleted`: it was produced " +
              "but has since been deleted; `never`: the step never produced one.",
          },
        },
      },
      readers: {
        type: "array",
        description: "The recipe's other steps whose present reads name the output.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            operation: { type: "string" },
            label: { type: "string" },
          },
        },
      },
      outputsRemain: { type: "boolean", description: "True only when the dataset exists." },
      message: { type: "string" },
    },
  },
  RecipeStepDiscarded: {
    type: "object",
    properties: {
      step: { $ref: "#/components/schemas/RecipeStep" },
      discarded: {
        type: "boolean",
        description: "Whether a pending edit was there to discard.",
      },
    },
  },
  LayoutPosition: {
    type: "object",
    description: "Canvas units at the canvas's natural zoom.",
    properties: { x: { type: "number" }, y: { type: "number" } },
    required: ["x", "y"],
  },
  LayoutNote: {
    type: "object",
    description:
      "A layout-only annotation: no reads, no output, no state, no " +
      "place in a run. Nothing in the recipe refers to it.",
    properties: {
      id: {
        type: "string",
        description: "Chosen by the writer; unique within the document.",
      },
      x: { type: "number" },
      y: { type: "number" },
      w: { type: "number", description: "Positive." },
      h: { type: "number", description: "Positive." },
      color: {
        type: "string",
        enum: ["yellow", "green", "blue", "pink", "purple", "grey"],
      },
      text: {
        type: "string",
        description:
          "Markdown, at most 4,000 characters, stored verbatim. The " +
          "canvas reads a `label:` line in a leading `---` block as " +
          "the note's label; the API interprets nothing.",
      },
    },
    required: ["id", "x", "y", "w", "h", "color", "text"],
  },
  RecipeLayoutInput: {
    type: "object",
    description:
      "The whole document. An absent map or list is the empty one.",
    properties: {
      steps: {
        type: "object",
        description: "A position per step, keyed by step id.",
        maxProperties: 1_000,
        propertyNames: { maxLength: 1_000 },
        additionalProperties: { $ref: "#/components/schemas/LayoutPosition" },
      },
      sources: {
        type: "object",
        description:
          "A position per source, keyed by table name. A source may " +
          "be positioned that no step reads yet: a loose table on the " +
          "canvas lives only here.",
        maxProperties: 1_000,
        propertyNames: { maxLength: 1_000 },
        additionalProperties: { $ref: "#/components/schemas/LayoutPosition" },
      },
      notes: {
        type: "array",
        description: "At most 100, in the writer's order.",
        items: { $ref: "#/components/schemas/LayoutNote" },
      },
    },
  },
  RecipeLayout: {
    allOf: [
      { $ref: "#/components/schemas/RecipeLayoutInput" },
      {
        type: "object",
        properties: {
          updatedAt: {
            type: ["string", "null"],
            description:
              "When the document was last written; null for one " +
              "never written.",
          },
        },
      },
    ],
  },
  RecipeLayoutEnvelope: {
    type: "object",
    properties: { layout: { $ref: "#/components/schemas/RecipeLayout" } },
  },
  RecipeDeleted: {
    type: "object",
    properties: {
      deleted: { type: "string" },
      outputsRemain: {
        type: "boolean",
        description:
          "Always true: a recipe's datasets survive its deletion.",
      },
      message: { type: "string" },
    },
  },
  RecipeRunAttempt: {
    type: "object",
    description:
      "What became of a member's attempt: the job's state, " +
      "error, times and output, composed from the live job while it is " +
      "in flight — so `queued` is told from `running` — and kept with " +
      "the run once it settles, so the run still says why a member " +
      "failed after the node's own history is pruned. A member never " +
      "attempted (`not_run`, or refused at admission) has none.",
    properties: {
      state: {
        type: "string",
        enum: ["queued", "running", "succeeded", "failed", "cancelled"],
      },
      error: {
        type: ["object", "null"],
        properties: { code: { type: "string" }, message: { type: "string" } },
      },
      acceptedAt: { type: "string" },
      startedAt: { type: ["string", "null"] },
      finishedAt: { type: ["string", "null"] },
      output: {
        type: ["object", "null"],
        description: "Null when the caller does not reach the dataset.",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
  },
  RecipeRunMember: {
    type: "object",
    properties: {
      stepId: { type: "string" },
      ordinal: { type: "integer" },
      operation: {
        type: ["string", "null"],
        description:
          "The node's operation when the run was planned, kept with the " +
          "run after the node is removed.",
      },
      name: {
        type: ["string", "null"],
        description:
          "The name the node was called by when the run was planned — " +
          "its dataset's, or the one it declared — kept after the node " +
          "is removed.",
      },
      output: {
        type: ["object", "null"],
        description: "The dataset this member published; null until it has.",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      attempt: {
        oneOf: [{ $ref: "#/components/schemas/RecipeRunAttempt" }, { type: "null" }],
      },
      state: {
        type: "string",
        enum: ["pending", "running", "succeeded", "failed", "not_run"],
        description:
          "`not_run` is the member's own condition and never a job " +
          "state: nothing was minted for it.",
      },
      jobId: {
        type: ["string", "null"],
        description: "The operation run this member minted; null for `not_run`.",
      },
      stoppedBy: {
        type: ["string", "null"],
        description:
          "What stopped it — the step id of the member whose failure " +
          "blocked it, or a coded reason.",
      },
      stoppedReason: {
        type: ["string", "null"],
        description:
          "The server's own sentence for that stop, where there is " +
          "one — for a member refused before any job existed, this is " +
          "the only field that names *which* input was missing or " +
          "which parameter was out of range. `stoppedBy` carries a " +
          "code, a blocking step id or `cancelled`, none of which a " +
          "reader can act on by itself.",
      },
    },
  },
  RecipeRun: {
    type: "object",
    description:
      "A recipe run is **not** an operation run. An operation run " +
      "names exactly one output; this may produce several, none, or a " +
      "mix of succeeded and never-attempted members — so it has its " +
      "own outcome and *contains* runs rather than being one.",
    properties: {
      id: { type: "string" },
      recipeId: { type: "string" },
      kind: { type: "string", enum: ["run_all", "from_step", "single"] },
      outcome: {
        type: ["string", "null"],
        enum: [
          "completed",
          "partly_completed",
          "failed",
          "cancelled",
          "interrupted",
          null,
        ],
        description:
          "Null while it is still going. `interrupted` is how a run " +
          "the server stopped mid-flight settles — it always reaches " +
          "a terminal outcome, and nothing is resumed.",
      },
      cancelled: { type: "boolean" },
      startedAt: { type: "string" },
      finishedAt: { type: ["string", "null"] },
      members: {
        type: "array",
        items: { $ref: "#/components/schemas/RecipeRunMember" },
      },
      outputs: {
        type: "array",
        description: "Every dataset this run produced: its runner's own.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
      runner: {
        oneOf: [{ $ref: "#/components/schemas/ResourceOwner" }, { type: "null" }],
        description:
          "Whose run it is: the person who started it, whose datasets " +
          "its outputs are. Null for a run recorded before runs were " +
          "attributed.",
      },
    },
  },
  RecipeRunEnvelope: {
    type: "object",
    properties: { run: { $ref: "#/components/schemas/RecipeRun" } },
  },
  RecipeRunList: {
    type: "object",
    properties: {
      runs: {
        type: "array",
        items: { $ref: "#/components/schemas/RecipeRun" },
      },
    },
  },
  RecipeRunPlan: {
    type: "object",
    properties: {
      plan: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["run_all", "from_step", "single"] },
          wide: {
            type: "boolean",
            description:
              "True when this would carry other steps with it. The " +
              "`when_wide` confirmation is about exactly this.",
          },
          members: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};
