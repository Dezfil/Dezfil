import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output keeps the Docker image to the app plus its used deps.
  output: "standalone",
  outputFileTracingIncludes: { "/*": ["./src/lib/assistant/model-catalogue.json"] },
  // The container omits test fixtures; npm run typecheck checks the full tree.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Native modules must stay external to the server bundle.
  serverExternalPackages: ["better-sqlite3", "@duckdb/node-api"],
  // The API docs live under Developer; the old path still resolves.
  async redirects() {
    return [
      { source: "/docs", destination: "/developer", permanent: false },
    ];
  },
};

export default nextConfig;
