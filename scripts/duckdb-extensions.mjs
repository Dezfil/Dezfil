// The single source of truth for the offline extension bundle: every DuckDB extension any supported road can demand at
// runtime. The image bake (install-duckdb-extensions.mjs) installs exactly
// this list; the offline CI check (check-duckdb-extensions-offline.mjs)
// proves every entry loads inside the built image with the network
// disabled — so "baked" is proven, not assumed.
export const EXTENSIONS = [
  // Core spatial engine.
  { name: "spatial" },
  // h3 (community) powers hexagonal aggregation.
  { name: "h3", repository: "community" },
  // httpfs powers remote-file and Overture imports.
  { name: "httpfs" },
  // json powers the OSM tags column.
  { name: "json" },
  // postgres powers PostGIS snapshot imports.
  { name: "postgres" },
  // azure powers az:// on the credential opt-in road;
  // without it baked, an air-gapped instance fails a scheme the API
  // advertises as supported.
  { name: "azure" },
  // aws powers the credential-chain secret for signed s3:// on the same
  // opt-in road; without it baked, signing degrades silently offline.
  { name: "aws" },
];
