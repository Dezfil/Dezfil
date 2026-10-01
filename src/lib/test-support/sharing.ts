import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";

/**
 * Project sharing fixtures written straight into the store: a project with its
 * people and the datasets filed in it. No route adds people yet, so tests that
 * need someone else's project arrange it here.
 */
export function shareProject(
  owner: string,
  project: string,
  people: [account: string, role: "viewer" | "editor"][],
  datasets: string[] = [],
  db: Database = metadataDb(),
): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?)")
    .run(project, `Project ${project}`, now, now, owner);
  for (const [account, role] of people) {
    db.prepare("INSERT INTO project_people VALUES (?, ?, ?, ?)").run(project, account, role, now);
  }
  for (const dataset of datasets) fileDataset(project, dataset, db);
}

export function fileDataset(project: string, dataset: string, db: Database = metadataDb()): void {
  db.prepare("INSERT INTO project_datasets VALUES (?, ?, ?)").run(project, dataset, new Date().toISOString());
}

export function unfileDataset(project: string, dataset: string, db: Database = metadataDb()): void {
  db.prepare("DELETE FROM project_datasets WHERE project_id = ? AND table_id = ?").run(project, dataset);
}
