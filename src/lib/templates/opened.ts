import type { LayoutNote } from "@/lib/metadata/recipe-layouts";

/**
 * What an installed template version holds, as the read of one answers it
 * and the template's page opens it. The map is read by its own id through
 * the map's roads; a workflow example's steps, with their parameters, and
 * its arrangement are here, since a template's workflow is no one's recipe
 * and the recipe roads answer it nothing.
 *
 * Dependency-free on purpose (types only), so the page's client half
 * reads the same shape the server half builds.
 */

/** A dataset or bundled result of the version, as the install measured it. */
export interface OpenedDataset {
  /** Its id as a template's dataset or result, never a stored row's. */
  id: string;
  name: string;
  rowCount: number;
  geometryColumn: string | null;
  geometryType: string | null;
}

/** One step of a workflow example: its definition, the result it came
 * with, and what it reads. */
export interface OpenedStep {
  id: string;
  operation: string;
  parameters: Record<string, unknown>;
  output: OpenedDataset;
  reads: string[];
}

export interface OpenedWorkflow {
  name: string;
  steps: OpenedStep[];
  layout: {
    steps: Record<string, { x: number; y: number }>;
    sources: Record<string, { x: number; y: number }>;
    notes: LayoutNote[];
    /** Null when the arrangement holds nothing, which the canvas arranges
     * by itself. */
    updatedAt: string | null;
  };
}

export interface TemplateContents {
  /** The version's revision: its archive's checksum, never changed. */
  revision: string;
  /** The template map's id, which every road a map's reader calls takes. */
  mapId: string;
  createdAt: string;
  updatedAt: string;
  datasets: OpenedDataset[];
  /** A workflow example's workflow; null for a map template. */
  workflow: OpenedWorkflow | null;
}
