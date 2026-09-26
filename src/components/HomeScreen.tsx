import Link from "next/link";
import styles from "./HomeScreen.module.css";

/* Placeholder content: real materials arrive later; every card is visibly
   "coming soon" so nothing reads as a broken link. The open-data cards are
   aimed at the divisions import once wired. */
const TEMPLATES = ["Urban mobility", "Regional choropleth", "Points of interest"];
const OPEN_DATA = ["Germany states", "Berlin neighborhoods", "European countries"];
const WORKFLOWS = ["Spatial join", "H3 aggregation", "Buffer & filter"];
const VIDEOS = [
  { title: "From file to first map", length: "4:10" },
  { title: "SQL layers in depth", length: "6:25" },
  { title: "Publishing & sharing", length: "3:40" },
];

function PlaceholderCard({
  name,
  meta,
}: {
  name: string;
  meta?: React.ReactNode;
}) {
  return (
    <div className={styles.card}>
      <span className={styles.cardName}>{name}</span>
      <span className={styles.cardFoot}>
        {meta}
        <span className={styles.soon}>coming soon</span>
      </span>
    </div>
  );
}

export function HomeScreen() {
  return (
    <div className={styles.screen}>
      <div className={styles.hero}>
        <h1>Welcome to Dezfil</h1>
        <p>
          Upload geospatial data, query it with SQL, style it on a map, and
          publish a shareable view.
        </p>
        <div className={styles.heroActions}>
          <Link href="/data" className={styles.primaryBtn}>
            Getting started
          </Link>
          <Link href="/developer" className={styles.ghostBtn}>
            Documentation
          </Link>
        </div>
      </div>

      <section className={styles.section}>
        <h2>Template maps</h2>
        <p className={styles.sectionSub}>
          Start from a finished map and swap in your own data.
        </p>
        <div className={styles.grid}>
          {TEMPLATES.map((name) => (
            <PlaceholderCard key={name} name={name} />
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>Enrich your project with open data</h2>
        <p className={styles.sectionSub}>
          Add curated boundaries and features with one click.
        </p>
        <div className={styles.grid}>
          {OPEN_DATA.map((name) => (
            <PlaceholderCard key={name} name={`Add ${name}`} />
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>Start creating workflows</h2>
        <p className={styles.sectionSub}>
          Repeatable analysis pipelines over your tables.
        </p>
        <div className={styles.grid}>
          {WORKFLOWS.map((name) => (
            <PlaceholderCard key={name} name={name} />
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>Learn to build with Dezfil</h2>
        <p className={styles.sectionSub}>
          Short videos covering the core loop.
        </p>
        <div className={styles.grid}>
          {VIDEOS.map((v) => (
            <PlaceholderCard
              key={v.title}
              name={v.title}
              meta={
                <span className={styles.videoMeta}>
                  <span className={styles.play} aria-hidden>
                    ▶
                  </span>
                  {v.length}
                </span>
              }
            />
          ))}
        </div>
      </section>
    </div>
  );
}
