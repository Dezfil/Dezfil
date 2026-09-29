import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function datasetAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Dataset names and identities resolve only in the authenticated account's space, including for administrators. Lists, schema discovery and counts include only that account's datasets. Upload and sketch suffixes ignore other accounts' names. Hidden or missing datasets, maps and project references return not_found before source or artifact access; a refused change leaves resources unchanged. Refresh and geometry changes preserve the dataset's identity and owner and recheck account activity at commit. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
