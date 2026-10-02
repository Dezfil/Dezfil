import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function datasetAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "A dataset is reached by its owner and by the owner and people of every project it is filed in. Lists, schema discovery and counts cover exactly the reached datasets and name each one's owner and the name the caller would type for it: the plain name for the caller's own, <sql name>.<name> for another owner's. Another owner's dataset is shown without connection facts and without links to what the caller cannot reach: a PostGIS snapshot shows its origin kind, with neither its connection nor its remote schema and table. A bare dataset name in a path or parameter is the caller's own dataset. On dataset reads, features, downloads and operation parameters, another owner's dataset the caller reaches is addressed by its qualified name, and in a /api/tables path also by its identifier; changing one by any address answers forbidden. Datasets change, refresh and go only by their owner; administrators reach nothing more. Upload and sketch suffixes ignore other accounts' names. Unreached and missing datasets, maps and project references return not_found before source or artifact access; a refused change leaves resources unchanged. Refresh and geometry changes preserve the dataset's identity and owner and recheck account activity at commit. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}
