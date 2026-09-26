import { readApiFailure } from "../api";
import { serverUnreachable } from "../failure-copy";
import type { GeometryChoice, GeometryInspection, GeometryPreview, GeometrySetResult, ProjectionList } from "./types";

/** A refusal as the API worded it: the sentence is never rewritten here. */
export class GeometryApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "GeometryApiError";
  }
}

/** The set-geometry operations published, and nothing else. */
export interface GeometryClient {
  inspect(name: string): Promise<GeometryInspection>;
  preview(name: string, expectedRevision: string, choice: GeometryChoice): Promise<GeometryPreview>;
  set(name: string, expectedRevision: string, choice: GeometryChoice): Promise<GeometrySetResult>;
  projections(epsg?: string): Promise<ProjectionList>;
}

const resource = (name: string) => `/api/tables/${encodeURIComponent(name)}/geometry`;

async function call<T>(url: string, doing: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error(serverUnreachable(doing));
  }
  if (!response.ok) {
    const failure = await readApiFailure(response);
    throw new GeometryApiError(failure.code, failure.message, response.status);
  }
  return (await response.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const geometryClient: GeometryClient = {
  inspect: (name) => call(resource(name), "inspect the geometry"),
  preview: (name, expectedRevision, choice) =>
    call(`${resource(name)}/preview`, "preview the choice", json("POST", { expectedRevision, choice })),
  set: (name, expectedRevision, choice) =>
    call(resource(name), "set the geometry", json("PUT", { expectedRevision, choice })),
  projections: (epsg) =>
    call(epsg === undefined ? "/api/geometry/projections" : `/api/geometry/projections?epsg=${encodeURIComponent(epsg)}`, "list the projections"),
};
