import { SQL_POLICY } from "./openapi-sql";
import { ownedCreationOp } from "./openapi-owned-creation";
import { jobAccess } from "./openapi-job-access";
import { LOCAL_READ, LOCAL_REPLACE, REMOTE_ADD } from "./operation-mcp";
import { READ_ONLY, writes, resource, planning } from "./operation-metadata";
import { op, jsonOk, pathParam } from "./openapi-helpers";

export const JOB_PATHS = {
  "/api/operations/run": {
    post: ownedCreationOp(jobAccess({
      summary: "Run an operation",
      description:
        "Accepts one operation and answers **202** with a run, before " +
        "the work is done; poll the run's own resource for its " +
        "outcome. An accepted run outlives the request that started " +
        "it. Closing the connection does not stop it.\n\n" +
        "What is refused here, and what is reported on the run, is a " +
        "fixed line. Refused immediately, minting no run: a malformed " +
        "body, an unknown operation, SQL that is not an accepted " +
        "read-only SELECT, an output name already taken, and a full " +
        "queue. Reported on the run instead: SQL that parses but " +
        "fails to bind or execute, a name taken between acceptance " +
        "and commit, the engine memory budget, the execution budget, " +
        "and a server stopped mid-run.\n\n" +
        "Set dryRun to ask what the operation would produce without " +
        "writing anything; a dry run is synchronous and mints no " +
        "run.\n\n" +
        SQL_POLICY + " " +
        "**sql_step** keeps the result of a read-only SELECT as a " +
        "dataset: the escape hatch inside any recipe, and the way to " +
        "save a query you already trust. A result with no geometry is " +
        "an ordinary dataset, not a failure.\n\n" +
        "**Measurements are ground metres.** A buffer's radius and a " +
        "measured length are metres on the earth, at the latitude the " +
        "data occupies, never degrees or metres on a map " +
        "projection. They are measured in a projection resolved from " +
        "the data's own extent, and the output's provenance records " +
        "which. Data spanning more than one local projection is " +
        "**refused** for a distance with `measurement_crs_unavailable`, " +
        "naming the extent it saw; an **area** over the same data " +
        "succeeds, because every area is measured in a global " +
        "equal-area projection. An input whose coordinate system was " +
        "assumed rather than declared is measured anyway and the answer " +
        "says so, on the dry run, on the accepted run, and on the " +
        "output.",
      tag: "Operations",
      tool: "run_operation", mcp: REMOTE_ADD,
      display: {"verb": "Ran the operation {arg.operation}", "planningVerb": "Planned the operation {arg.operation}"},
      relevance: ["builder", "workflow"],
      effects: planning("dryRun", writes(resource("runs", "", "run.id"), resource("tables"))),
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
                    "describes them.",
                },
                subject: {
                  type: "string",
                  description:
                    "Groups this run with others in history, so " +
                    "'when did this last succeed' has an answer " +
                    "across re-runs. Omitted, the run is its own " +
                    "subject.",
                },
                dryRun: {
                  type: "boolean",
                  description:
                    "Report what the run would produce and write nothing.",
                },
              },
              required: ["operation", "parameters"],
            },
            example: {
              operation: "sql_step",
              parameters: {
                sql: "SELECT borough, count(*) AS n FROM accidents GROUP BY borough",
                name: "accidents_by_borough",
              },
            },
          },
        },
      },
      responses: {
        "200": jsonOk(
          "#/components/schemas/OperationDryRun",
          "What the run would produce; nothing written.",
        ),
        "202": jsonOk(
          "#/components/schemas/OperationRunEnvelope",
          "Accepted; poll the run for its outcome.",
        ),
      },
    })),
  },
  "/api/operations/runs": {
    get: op(jobAccess({
      summary: "List operation runs",
      description:
        "Run history, newest first. Narrow to one subject to answer " +
        "'when did this last succeed'. A failed run never erases the " +
        "successful one before it, so both are kept. History is " +
        "bounded per subject, and a subject's most recent success is " +
        "preserved even when the depth would otherwise drop it.",
      tag: "Operations",
      tool: "list_operation_runs", mcp: LOCAL_READ,
      display: {"verb": "Listed the operation runs"},
      relevance: ["workflow"],
      effects: READ_ONLY,
      parameters: [
        {
          name: "subject",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Only runs sharing this subject identity.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer" },
          description: "Most runs to return; newest first.",
        },
      ],
      responses: {
        "200": jsonOk("#/components/schemas/OperationRunList"),
      },
    })),
  },
  "/api/operations/runs/{id}": {
    get: op(jobAccess({
      summary: "Read an operation run",
      description:
        "What a caller polls after the run endpoint accepted their " +
        "operation. A succeeded run names its output dataset; a " +
        "failed one carries a coded error. There is no completion " +
        "percentage: a run reports when it started, and elapsed time " +
        "follows from that.",
      tag: "Operations",
      tool: "get_operation_run", mcp: LOCAL_READ,
      display: {"verb": "Read the operation run {subject}", "subject": {"resource": "runs", "argument": "id"}},
      relevance: ["workflow"],
      effects: READ_ONLY,
      parameters: [pathParam("id", "Run id.")],
      responses: {
        "200": jsonOk("#/components/schemas/OperationRunEnvelope"),
      },
    })),
  },
  "/api/operations/runs/{id}/cancel": {
    post: op(jobAccess({
      summary: "Cancel an operation run",
      description:
        "Stops a run for real: a queued one never starts, and a " +
        "running one is interrupted in the engine rather than only " +
        "in the record. A cancelled run leaves no dataset and no " +
        "stranded file behind. Cancelling a run that has already " +
        "finished is not an error. It answers the run unchanged, " +
        "because 'make sure this is not running' is already true.",
      tag: "Operations",
      tool: "cancel_operation_run", mcp: LOCAL_REPLACE,
      display: {"verb": "Cancelled the operation run {subject}", "subject": {"resource": "runs", "argument": "id"}},
      relevance: ["workflow"],
      effects: writes(resource("runs", "id")),
      parameters: [pathParam("id", "Run id.")],
      responses: {
        "200": jsonOk("#/components/schemas/OperationRunEnvelope"),
      },
    })),
  },
};
