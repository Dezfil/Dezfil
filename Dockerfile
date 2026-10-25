# Dezfil ships as one image: app, API, and query engine in a single container.
# Debian-based (not Alpine) because DuckDB's prebuilt native bindings target glibc.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Tippecanoe turns layer results into PMTiles archives. Built from
# the same base as the runner so the linked libraries match.
FROM node:24-slim AS tiler
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libsqlite3-dev zlib1g-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ARG TIPPECANOE_VERSION=2.79.0
RUN curl -fsSL "https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE_VERSION}.tar.gz" \
      | tar -xz --strip-components=1 \
    && make -j"$(nproc)" tippecanoe

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
# The standalone trace copies what a package's code needs, not its licence;
# put every traced package's licence files back beside it.
RUN node scripts/standalone-licences.mjs node_modules .next/standalone/node_modules
# Bake DuckDB extensions so runtime needs no network (air-gapped friendly).
# The slim base ships no CA bundle; DuckDB fetches the extensions over HTTPS
# from extensions.duckdb.org, so install ca-certificates first or the TLS
# handshake fails with "Problem with the SSL CA cert".
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && node scripts/install-duckdb-extensions.mjs /app/duckdb-extensions

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DEZFIL_DATA_DIR=/data \
    DUCKDB_EXTENSION_DIR=/app/duckdb-extensions

# Run as the unprivileged node user; /data is the single durable directory.
# libsqlite3-0 is tippecanoe's one runtime dependency beyond the base image.
# Chromium renders server-side image exports by driving the app's own client
# bundle. That is the accepted price of the one-container promise: roughly
# 700 MB more for the browser stack, measured. Chromium uses its own roots
# and the node user's NSS stores. Node uses its bundled roots plus the PEM
# file named by NODE_EXTRA_CA_CERTS. Private CAs need both client and
# browser trust (docs/self-host/what-leaves-the-instance.md). fonts-liberation covers any
# text outside the app's self-hosted faces. The WebGL path runs software GL
# through SwiftShader, which works in this base with no network.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libsqlite3-0 chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
ENV DEZFIL_CHROMIUM_PATH=/usr/bin/chromium
COPY --from=tiler /src/tippecanoe /usr/local/bin/tippecanoe
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# 0214: runtime reads this maintained file at its source-relative path.
COPY --from=build --chown=node:node /app/src/lib/assistant/model-catalogue.json ./src/lib/assistant/model-catalogue.json
# The shipped templates: an index and one installed folder per version,
# read at their source-relative path, so they work with no network.
COPY --from=build --chown=node:node /app/templates ./templates
# Next's standalone server does not promise to copy `public`; carry the
# application-owned runtime assets explicitly (including the MVT parser
# worker) so the one-container renderer never depends on build leftovers.
COPY --from=build --chown=node:node /app/public ./public
# The socket provenance preload runs before the unchanged standalone launcher.
COPY --from=build --chown=node:node /app/scripts/ingress-preload.mjs /app/scripts/preload-options.mjs ./scripts/
COPY --from=build --chown=node:node /app/src/lib/auth/ingress.mjs /app/src/lib/auth/reception.mjs ./src/lib/auth/
# Local recovery runs without the server or a TypeScript loader.
COPY --from=build --chown=node:node /app/scripts/admin-recover.mjs ./scripts/admin-recover.mjs
COPY --from=build --chown=node:node /app/src/lib/auth/link-issuance.mjs ./src/lib/auth/link-issuance.mjs
COPY --from=build --chown=node:node /app/src/lib/auth/recovery-store.mjs ./src/lib/auth/recovery-store.mjs
COPY --from=build --chown=node:node /app/src/lib/auth/recovery.mjs ./src/lib/auth/recovery.mjs
# Licensing for vendored runtime assets must survive even if Next's file
# tracing becomes narrower than today's whole-project trace.
COPY --from=build --chown=node:node /app/LICENSE /app/NOTICE ./
COPY --from=build --chown=node:node /app/duckdb-extensions ./duckdb-extensions
# Next's standalone tracer misses native binaries (libduckdb.so, the
# better-sqlite3 prebuild); copy those packages in whole so the engine loads.
COPY --from=build --chown=node:node /app/node_modules/@duckdb ./node_modules/@duckdb
COPY --from=build --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build --chown=node:node /app/node_modules/bindings ./node_modules/bindings
COPY --from=build --chown=node:node /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
# Profile pictures are decoded and re-encoded by sharp: its package, the
# binary and libvips of the image's own architecture under @img, and the two
# packages its JavaScript requires, whole.
COPY --from=build --chown=node:node /app/node_modules/sharp ./node_modules/sharp
COPY --from=build --chown=node:node /app/node_modules/@img ./node_modules/@img
COPY --from=build --chown=node:node /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=build --chown=node:node /app/node_modules/semver ./node_modules/semver

USER node
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "--import=./scripts/ingress-preload.mjs", "server.js"]
