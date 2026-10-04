#!/bin/sh
# Outside driver. Expect 300-600 added seconds after the image is built;
# actual elapsed seconds are printed by the probe, never inferred here.
set -eu
image=${1:-dezfil:ci}
run_id="$$"
small="dezfil-budget-small-$run_id"
normal="dezfil-budget-normal-$run_id"
source="dezfil-budget-source-$run_id"
cleanup() {
  docker logs "$small" 2>/dev/null || true
  docker logs "$normal" 2>/dev/null || true
  docker rm -f -v "$source" "$small" "$normal" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
start() {
  name=$1; port=$2; memory=$3
  docker run -d --name "$name" --network=none \
    -e PORT="$port" -e DEZFIL_QUERY_MEMORY_MB="$memory" \
    -e DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 \
    -v "$PWD/scripts:/probes:ro" "$image"
  ready=0
  for attempt in $(seq 1 60); do
    if docker exec "$name" node -e "fetch('http://127.0.0.1:$port/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then ready=1; break; fi
    sleep 1
  done
  test "$ready" = 1
}
start "$small" 3401 32
docker exec "$small" node /probes/query-result-budget-probe.mjs http://127.0.0.1:3401 container --refused
start "$normal" 3402 512
# Disposable source fixture only. The product still runs in its one image.
docker run -d --name "$source" --network="container:$normal" \
  -e POSTGRES_DB=budget -e POSTGRES_USER=budget -e POSTGRES_PASSWORD=budget-fixture-only \
  postgis/postgis:16-3.4
ready=0
for attempt in $(seq 1 60); do
  # The initialization server accepts sockets only. Require stable TCP on
  # the same address used by the app, including across an initialization restart.
  if docker exec "$source" pg_isready -h 127.0.0.1 -p 5432 -U budget -d budget; then
    ready=$((ready + 1))
    if test "$ready" = 3; then break; fi
  else
    ready=0
  fi
  sleep 1
done
if test "$ready" != 3; then
  docker logs "$source" >&2 || true
  echo 'PostGIS source did not become ready over TCP at 127.0.0.1:5432' >&2
  exit 1
fi
docker exec -e DEZFIL_TEST_PG_URL=postgresql://budget:budget-fixture-only@127.0.0.1:5432/budget \
  "$normal" node /probes/query-result-budget-probe.mjs http://127.0.0.1:3402 container --full
docker exec "$normal" node /probes/query-result-budget-probe.mjs http://127.0.0.1:3402 container --admitted
