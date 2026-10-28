#!/usr/bin/env bash
set -euo pipefail
jvc_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
jvc_engine=${JVC_CONTAINER_ENGINE:-podman}
jvc_image=${JVC_CONTAINER_IMAGE:-localhost/jbovlacku:prototype}
"$jvc_engine" build --file "$jvc_root/Containerfile" --tag "$jvc_image" "$@" "$jvc_root"
