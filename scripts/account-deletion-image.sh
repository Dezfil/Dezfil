#!/bin/sh
# The image-job mirror. All containers, named/anonymous volumes and scratch are owned here.
set -eu
if [ "$#" -gt 1 ]; then echo 'Usage: account-deletion-image.sh [image]' >&2; exit 2; fi
image=${1:-dezfil:ci}
: "${DEZFIL_DATA_DIR:?Set a fresh scratch root}"
mkdir -p "$DEZFIL_DATA_DIR"
test -z "$(ls -A "$DEZFIL_DATA_DIR")"
started=$(date +%s)
name="dezfil-deletion-$$-$started"
volume="$name-data"
proof="$DEZFIL_DATA_DIR/proof"
mkdir "$proof" "$proof/control"
chmod 777 "$proof" "$proof/control"
cleanup() {
  result=$?
  trap - EXIT
  docker logs "$name" > "$DEZFIL_DATA_DIR/server-final.log" 2>&1 || true
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  for i in $(seq 1 50); do docker container inspect "$name" >/dev/null 2>&1 || break; sleep 0.2; done
  if docker container inspect "$name" >/dev/null 2>&1; then echo 'Cleanup could not remove the deletion container' >&2; result=1; fi
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume rm "$volume" >/dev/null || result=1
  fi
  rm -rf "$proof"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
docker volume create "$volume" >/dev/null
start() {
  docker run --pull=never -d --rm --name "$name" --network=none \
    -e PORT=3403 -e DEZFIL_DATA_DIR=/data -e DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 \
    -e DEZFIL_AI_PROVIDER=openai -e OPENAI_API_KEY=proof-only -e OPENAI_BASE_URL=http://127.0.0.1:3404/v1 \
    -e DEZFIL_PROOF_CONTROL_DIR=/proof/control \
    -e NODE_OPTIONS=--import=/probes/account-deletion-journey-preload.mjs \
    -v "$PWD/scripts:/probes:ro" -v "$proof:/proof" -v "$volume:/data" "$image" >/dev/null
  for i in $(seq 1 60); do
    if docker exec "$name" node -e "fetch('http://127.0.0.1:3403/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then return 0; fi
    sleep 1
  done
  return 1
}
journey() {
  docker exec "$name" node /probes/account-deletion-journey.mjs "$1" http://127.0.0.1:3403 /proof/state.json /data /proof/control 3404
}
start
journey seed
docker logs "$name" > "$DEZFIL_DATA_DIR/server-before-replacement.log" 2>&1
docker stop "$name" >/dev/null
# --rm removes the container after stop returns; wait until the name is free.
for i in $(seq 1 50); do docker container inspect "$name" >/dev/null 2>&1 || break; sleep 0.2; done
if docker container inspect "$name" >/dev/null 2>&1; then echo 'Previous container name is still in use' >&2; exit 1; fi
start
journey verify
# Packaged recovery owns a terminal; retain its secret only in the scratch handshake.
docker exec -t "$name" node scripts/admin-recover.mjs --data-dir /data --origin http://127.0.0.1:3403 > "$proof/recovery-terminal"
node --input-type=module -e 'import fs from "node:fs"; const s=fs.readFileSync(process.argv[1],"utf8"); const links=s.match(/https?:\/\/[^\s]+\/accept#secret=dz_link_[\w-]+/g)??[]; if(links.length!==1)throw new Error("packaged recovery issues one link"); fs.writeFileSync(process.argv[2],links[0],{mode:0o644});' "$proof/recovery-terminal" "$proof/control/recovery-link"
journey recover
printf 'PASS: confirmed account deletion image journey in %s seconds\n' "$(($(date +%s) - started))"
