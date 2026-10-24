#!/usr/bin/env bash
set -euo pipefail
jvc_engine=${JVC_CONTAINER_ENGINE:-podman}
jvc_image=${JVC_CONTAINER_IMAGE:-localhost/jbovlacku:prototype}
jvc_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
jvc_test_root=${JVC_CONTAINER_TEST_DIR:-$jvc_root/.cache/container-tests}
mkdir -p "$jvc_test_root"
jvc_scratch=$(mktemp -d "$jvc_test_root/container-smoke.XXXXXX")
jvc_name="jvc-container-smoke-$$-$RANDOM"
jvc_volume="$jvc_name-data"
jvc_created_volume=false
jvc_container_id=
cleanup() {
  if [[ -n "$jvc_container_id" ]]; then
    "$jvc_engine" logs "$jvc_container_id" >>"$jvc_scratch/runtime.log" 2>&1 || true
    "$jvc_engine" rm --force "$jvc_container_id" >/dev/null 2>&1 || true
  fi
  if [[ "$jvc_created_volume" == true ]]; then
    "$jvc_engine" volume rm "$jvc_volume" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
if "$jvc_engine" volume inspect "$jvc_volume" >/dev/null 2>&1; then
  echo 'The disposable volume name already exists.' >&2
  exit 1
fi
"$jvc_engine" volume create "$jvc_volume" >/dev/null
jvc_created_volume=true
start_container() {
  jvc_container_id=$("$jvc_engine" create --name "$jvc_name" \
    --publish 127.0.0.1::8789 \
    --mount "type=volume,source=$jvc_volume,target=/var/lib/jbovlacku" \
    --env JVC_SERVER_ID=container-smoke --env JVC_LOG_ERRORS=enabled "$jvc_image")
  "$jvc_engine" start "$jvc_container_id" >/dev/null
  jvc_address=$("$jvc_engine" port "$jvc_container_id" 8789/tcp)
  jvc_base="http://$jvc_address"
  for ((jvc_attempt = 0; jvc_attempt < 60; jvc_attempt++)); do
    if curl --silent --fail --max-time 2 "$jvc_base/api/health/ready" >"$jvc_scratch/health.json"; then
      return
    fi
    sleep 1
  done
  "$jvc_engine" logs "$jvc_container_id" >&2
  echo 'The container did not become ready.' >&2
  return 1
}
stop_container() {
  "$jvc_engine" stop --time 15 "$jvc_container_id" >/dev/null
  "$jvc_engine" inspect --format '{{.State.ExitCode}}' "$jvc_container_id" >"$jvc_scratch/exit-code.txt"
  if [[ $(cat "$jvc_scratch/exit-code.txt") != 0 ]]; then
    "$jvc_engine" logs "$jvc_container_id" >&2
    echo 'The container did not stop cleanly.' >&2
    return 1
  fi
  "$jvc_engine" logs "$jvc_container_id" >>"$jvc_scratch/runtime.log" 2>&1
  "$jvc_engine" rm "$jvc_container_id" >/dev/null
  jvc_container_id=
}
start_container
"$jvc_engine" exec "$jvc_container_id" id -u >"$jvc_scratch/uid.txt"
if [[ $(cat "$jvc_scratch/uid.txt") == 0 ]]; then
  echo 'The standalone service must run as a non-root user.' >&2
  exit 1
fi
"$jvc_engine" exec --interactive "$jvc_container_id" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
for (const name of ['dependencies.md', 'third-party-notices.md', 'rust-standard-library-notices.html', 'morphology-notices.md']) {
  assert((await stat('/app/docs/' + name)).size > 0, 'The image lacks a dependency notice: ' + name);
  assert.deepEqual(await readFile('/app/docs/' + name), await readFile('/app/apps/web/dist/notices/' + name), 'The browser notice differs: ' + name);
  assert.deepEqual(await readFile('/app/docs/' + name), await readFile('/app/apps/server/dist/notices/' + name), 'The server notice differs: ' + name);
}
JS
curl --silent --show-error --fail "$jvc_base/" >"$jvc_scratch/index.html"
curl --silent --show-error --fail "$jvc_base/notices/" >"$jvc_scratch/notices-index.html"
curl --silent --show-error --fail "$jvc_base/api/v1/capabilities" >"$jvc_scratch/capabilities.json"
"$jvc_engine" exec --interactive "$jvc_container_id" node --input-type=module >"$jvc_scratch/signed.json" <<'JS'
import { readFile } from 'node:fs/promises';
import init, { canonicalize, content_hash, identity, sign_record } from '/app/packages/core/generated/jvc_runtime.js';
await init({ module_or_path: await readFile('/app/packages/core/generated/jvc_runtime_bg.wasm') });
const seed = new Uint8Array(32).fill(173);
const header = { version: 1, issuer: identity(seed), previous: [], nonce: 'a'.repeat(32), action: { kind: 'identity.merge' }, content: null };
const envelope = JSON.parse(sign_record(seed, new TextEncoder().encode(JSON.stringify(header))));
console.log(JSON.stringify({ transport: { envelope, body: null }, envelope_hash: content_hash(canonicalize(new TextEncoder().encode(JSON.stringify(envelope)))) }));
JS
python3 - "$jvc_scratch" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
signed = json.loads((root / 'signed.json').read_text())
(root / 'carrier.json').write_text(json.dumps(signed['transport']))
PY
jvc_status=$(curl --silent --show-error --output "$jvc_scratch/first.json" --write-out '%{http_code}' \
  --header 'content-type: application/json' --header "origin: $jvc_base" \
  --data-binary "@$jvc_scratch/carrier.json" "$jvc_base/api/v1/events")
[[ "$jvc_status" == 201 ]] || { cat "$jvc_scratch/first.json" >&2; exit 1; }
jvc_event=$(python3 - "$jvc_scratch/carrier.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))['envelope']['id'])
PY
)
wait_materialized() {
  local jvc_phase=$1
  local jvc_deadline=$((SECONDS + 60))
  local jvc_remaining jvc_result
  while ((SECONDS < jvc_deadline)); do
    jvc_remaining=$((jvc_deadline - SECONDS))
    ((jvc_remaining > 2)) && jvc_remaining=2
    if ! curl --silent --show-error --fail --max-time "$jvc_remaining" \
      "$jvc_base/api/v1/receipts/$jvc_event" >"$jvc_scratch/$jvc_phase-receipt.json"; then
      sleep 1
      continue
    fi
    jvc_remaining=$((jvc_deadline - SECONDS))
    ((jvc_remaining > 0)) || break
    ((jvc_remaining > 2)) && jvc_remaining=2
    if ! curl --silent --show-error --fail --max-time "$jvc_remaining" \
      "$jvc_base/api/v1/manifest" >"$jvc_scratch/$jvc_phase-manifest.json"; then
      sleep 1
      continue
    fi
    jvc_result=0
    python3 - "$jvc_scratch" "$jvc_phase" <<'PY' || jvc_result=$?
import json, pathlib, sys
root, phase = pathlib.Path(sys.argv[1]), sys.argv[2]
def load(name):
    return json.loads((root / name).read_text())
try:
    signed = load('signed.json')
    first = load('first.json')
    receipt = load(phase + '-receipt.json')
    manifest = load(phase + '-manifest.json')
    assert first['admission'] == 'accepted', 'The first POST did not admit the event.'
    assert isinstance(first['cursor'], str) and first['cursor'], 'Admission lacks a receipt position.'
    for value in [first, receipt]:
        assert value['id'] == signed['transport']['envelope']['id'], 'The receipt names another event.'
        assert value['admission'] in ['accepted', 'duplicate'], 'The stored event was refused.'
        assert value['envelope_hash'] == signed['envelope_hash'], 'The receipt names another envelope.'
        assert value['body_status'] == 'none' and value['body_hash'] is None, 'The bodyless event gained a body.'
        assert value['cursor'] == first['cursor'], 'The receipt position changed.'
    assert manifest['accepted_cursor'] == first['cursor'], 'The accepted cursor changed without another write.'
    ready = (isinstance(receipt['snapshot'], str) and receipt['snapshot'].startswith('sha256:')
             and receipt['snapshot'] == manifest['snapshot']
             and manifest['materialized_cursor'] == first['cursor']
             and not {'index_lag', 'evaluation_pending'}.intersection(receipt['reasons']))
except (AssertionError, KeyError, TypeError, ValueError) as error:
    print(error, file=sys.stderr)
    sys.exit(2)
sys.exit(0 if ready else 1)
PY
    if ((jvc_result == 0)); then return; fi
    if ((jvc_result != 1)); then return "$jvc_result"; fi
    sleep 1
  done
  echo "The $jvc_phase receipt did not reach a completed snapshot within 60 seconds." >&2
  return 1
}
wait_materialized first-completed
stop_container
start_container
curl --silent --show-error --fail "$jvc_base/api/v1/events/$jvc_event" >"$jvc_scratch/reopened.json"
jvc_status=$(curl --silent --show-error --output "$jvc_scratch/retry.json" --write-out '%{http_code}' \
  --header 'content-type: application/json' --header "origin: $jvc_base" \
  --data-binary "@$jvc_scratch/carrier.json" "$jvc_base/api/v1/events")
[[ "$jvc_status" == 200 ]] || { cat "$jvc_scratch/retry.json" >&2; exit 1; }
wait_materialized retry-completed
curl --silent --show-error --fail "$jvc_base/api/v1/changes" >"$jvc_scratch/changes.json"
python3 - "$jvc_scratch" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
def load(name):
    return json.loads((root / name).read_text())
assert load('reopened.json') == load('carrier.json')['envelope'], 'The stored event changed after restart.'
first, retry = load('first.json'), load('retry.json')
assert retry['admission'] == 'duplicate', 'Retry did not report the existing event.'
for key in ['id', 'cursor', 'envelope_hash', 'body_status', 'body_hash']:
    assert first[key] == retry[key], 'Retry changed receipt evidence: ' + key
# This fresh volume has one event and no other writes, so its completed inventory stays identical.
assert load('first-completed-receipt.json')['snapshot'] == load('retry-completed-receipt.json')['snapshot'], 'Restart changed the completed inventory.'
for phase, posted in [('first', first), ('retry', retry)]:
    if posted['snapshot'] is not None:
        assert posted['snapshot'] == load(phase + '-completed-receipt.json')['snapshot'], 'The POST named another completed inventory.'
assert load('changes.json')['items'] == [{'cursor': first['cursor'], 'id': first['id']}], 'The journal changed the single receipt.'
assert 'html' in (root / 'index.html').read_text().lower(), 'The image did not serve the browser.'
assert 'third-party-notices.md' in (root / 'notices-index.html').read_text(), 'The notice index is not accessible.'
assert 'morphology-notices.md' in (root / 'notices-index.html').read_text(), 'The morphology notice is not linked.'
PY
stop_container
echo "Container persistence and clean shutdown passed. Test files: $jvc_scratch"
