import Link from "next/link";
import gallery from "@/components/gallery.module.css";
import styles from "./ItemNotFound.module.css";

const inProject = (noun: string) =>
  `There's no ${noun} at this address, or it's in a project that isn't shared with you. If someone sent you the link, ask them to add you to the project.`;

/** Each kind's words and way back. A missing item and one the person cannot
 * reach read the same, so the page never says whether it exists. */
const KINDS = {
  map: { title: "Map not found", text: inProject("map"), back: "Go to Maps", href: "/maps" },
  workflow: { title: "Workflow not found", text: inProject("workflow"), back: "Go to Workflows", href: "/workflows" },
  dataset: { title: "Dataset not found", text: inProject("dataset"), back: "Go to Data", href: "/data" },
  project: {
    title: "Project not found",
    text: "There's no project at this address, or it isn't shared with you. If someone sent you the link, ask them to add you to it.",
    back: "Go to Projects",
    href: "/projects",
  },
  template: { title: "Template not found", text: "There's no template at this address.", back: "Go to Templates", href: "/templates" },
} as const;

export function ItemNotFound({ kind }: { kind: keyof typeof KINDS }) {
  const { title, text, back, href } = KINDS[kind];
  return (
    <div className={styles.card}>
      <h1>{title}</h1>
      <p>{text}</p>
      <Link className={gallery.primary} href={href}>{back}</Link>
    </div>
  );
}
