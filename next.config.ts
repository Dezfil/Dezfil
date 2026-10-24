import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output keeps the Docker image to the app plus its used deps.
  output: "standalone",
  // Leave the complete 16 MiB JSON tier and its refusal boundary intact.
  // Multipart uploads bypass the proxy copy and stream in their handler; the
  // anonymous published and entry posts bypass it and read 64 KiB at most.
  // An address no page answers renders src/app/global-not-found.tsx with a
  // 404 status: with several root layouts there is no top-level one to hold
  // the framework's not-found page otherwise.
  experimental: { proxyClientMaxBodySize: 17 * 1024 * 1024, globalNotFound: true },
  outputFileTracingIncludes: { "/*": ["./src/lib/assistant/model-catalogue.json"] },
  // The container omits test fixtures; npm run typecheck checks the full tree.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Native modules must stay external to the server bundle.
  serverExternalPackages: ["better-sqlite3", "@duckdb/node-api", "sharp"],
  // next dev would otherwise write its own block into AGENTS.md whenever it
  // detects a coding agent; the brief in that file is maintained by hand.
  agentRules: false,
  // The image renderer opens its pages at 127.0.0.1, the address the server
  // reaches itself on. The development server answers its reload socket and
  // other development resources only to hosts it knows, and by default it
  // knows only localhost. Only the development server reads this setting.
  allowedDevOrigins: ["127.0.0.1"],
  // The API reference lives at /developer; the old path still resolves.
  async redirects() {
    return [
      { source: "/docs", destination: "/developer", permanent: false },
    ];
  },
};

export default nextConfig;
