import { buildOpenApiDocument } from "@/lib/api/openapi";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { OPERATIONS } from "@/lib/operations/catalog";
import { ExternalIcon } from "./ui/icons";
import styles from "./DocsScreen.module.css";

const METHOD_ORDER = ["get", "post", "patch", "put", "delete"];

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
}

/** Human-readable API docs rendered from the OpenAPI description — same source
 * of truth, so they cannot diverge (spec). Self-contained, no external UI. */
export function DocsScreen() {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as Record<string, Record<string, Operation>>;

  const byTag = new Map<string, { path: string; method: string; op: Operation }[]>();
  for (const [path, methods] of Object.entries(paths)) {
    for (const method of METHOD_ORDER) {
      const op = methods[method];
      if (!op) continue;
      const tag = op.tags?.[0] ?? "Other";
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push({ path, method, op });
    }
  }

  const tags = (doc.tags as { name: string; description: string }[]) ?? [];

  return (
    <div className={styles.screen}>
      <div className={styles.heading}>
        <h1>API</h1>
        <p>{doc.info.description}</p>
        <div className={styles.links}>
          <a href="/api/openapi.json" className={styles.specLink}>
            OpenAPI description (JSON) <ExternalIcon />
          </a>
        </div>
      </div>

      {tags.map((tag) => {
        const ops = byTag.get(tag.name);
        if (!ops) return null;
        return (
          <section key={tag.name} className={styles.section}>
            <h2 className={styles.sectionTitle}>{tag.name}</h2>
            <p className={styles.sectionDesc}>{tag.description}</p>
            <div className={styles.ops}>
              {ops.map(({ path, method, op }) => (
                <div key={`${method} ${path}`} className={styles.op}>
                  <div className={styles.opHead}>
                    <span className={styles.method} data-method={method}>
                      {method.toUpperCase()}
                    </span>
                    <code className={styles.path}>{path}</code>
                  </div>
                  <div className={styles.opSummary}>{op.summary}</div>
                  {op.description && (
                    <div className={styles.opDesc}>{op.description}</div>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {/* The one-endpoint operation API is right for an agent — one verb it
          discovers instead of twenty near-identical ones — but it would make
          the operations themselves invisible to a person reading this page,
          who would see only "run an operation". The accepted cost of that
          shape was that the verbs are still presented individually, and this
          is where that presentation begins for the specs that add the rest. */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Operations</h2>
        <p className={styles.sectionDesc}>
          Verbs that <code>POST /api/operations/run</code> accepts. Each
          produces a durable dataset with recorded provenance. The same list is
          served as data by <code>GET /api/operations</code>.
        </p>
        <p className={styles.sectionDesc}>
          {/* The third place the collision has to be resolved, and the only
              one a human reads outside the builder. Web mercator is named,
              and the number is not softened — it is exact, and simply a
              length on a projection. */}
          <strong>Units.</strong> Every distance and length these verbs take or
          produce is <strong>ground metres</strong>: metres on the earth, at
          the latitude the data occupies. The one number in this product that
          is not is a hex-bin or grid <strong>cell size</strong>, which is a
          length in <strong>web-mercator</strong> kilometres: a length on the
          map projection, not a ground distance. Web mercator stretches by
          1/cos(latitude), so a 1.2 km cell covers about 730 m of ground at
          52°N and about 410 m at 70°N.
        </p>
        <div className={styles.ops}>
          {OPERATIONS.map((operation) => (
            <div key={operation.id} className={styles.op}>
              <div className={styles.opHead}>
                <span className={styles.method} data-method="post">
                  {operation.group}
                </span>
                <code className={styles.path}>{operation.id}</code>
              </div>
              <div className={styles.opSummary}>{operation.label}</div>
              <div className={styles.opDesc}>{operation.description}</div>
              <div className={styles.opDesc}>
                {operation.parameters.map((parameter) => (
                  <div key={parameter.name}>
                    <code>{parameter.name}</code> ({parameter.type}
                    {parameter.unit === "metres"
                      ? ", metres on the ground"
                      : parameter.unit === "minutes"
                        ? ", minutes of travel time"
                        : ""}
                    {parameter.required ? ", required" : ", optional"}):{" "}
                    {parameter.description}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Error codes</h2>
        <p className={styles.sectionDesc}>
          Every error response carries a machine-readable <code>code</code> and
          a human <code>message</code>.
        </p>
        <table className={styles.errorTable}>
          <tbody>
            {Object.entries(ERROR_CATALOGUE).map(([code, meaning]) => (
              <tr key={code}>
                <td>
                  <code>{code}</code>
                </td>
                <td>{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
