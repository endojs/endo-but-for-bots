#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
first="localhost/endo-codex-repro-first:$$"
second="localhost/endo-codex-repro-second:$$"
first_layout=$(mktemp -d "${TMPDIR:-/tmp}/endo-codex-oci-first.XXXXXX")
second_layout=$(mktemp -d "${TMPDIR:-/tmp}/endo-codex-oci-second.XXXXXX")
first_digest="$first_layout/digest"
second_digest="$second_layout/digest"

podman version --format 'builder={{.Client.Version}}'

cleanup() {
  podman image rm --force "$first" "$second" >/dev/null 2>&1 || true
  rm -rf -- "$first_layout" "$second_layout"
}
trap cleanup EXIT HUP INT TERM

"$script_dir/build-reproducible.sh" "$first"
"$script_dir/build-reproducible.sh" "$second"

podman push --quiet --digestfile "$first_digest" "$first" \
  "oci:$first_layout:reproducible"
podman push --quiet --digestfile "$second_digest" "$second" \
  "oci:$second_layout:reproducible"
cmp -s "$first_digest" "$second_digest"
cat "$first_digest"
