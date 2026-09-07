#!/usr/bin/env bash
# Execute faults under the exact ignorelist to prove that its source boundary
# excludes only upstream UBSAN, never our C code or upstream ASAN.
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
probe_directory=$(mktemp -d)
trap 'rm -r -- "$probe_directory"' EXIT
# Expected faults should exit nonzero without generating crash/core artifacts.
export ASAN_OPTIONS=halt_on_error=1:abort_on_error=0:exitcode=1
export UBSAN_OPTIONS=halt_on_error=1:abort_on_error=0:exitcode=1

check_probe() {
  local name=$1 path=$2 mode=$3 diagnostic=$4
  local source="$probe_directory/$path"
  mkdir -p -- "$(dirname -- "$source")"
  cp -- "$script_directory/tests/sanitizer-probe.c" "$source"
  local flags=()
  if [[ $mode == address ]]; then
    flags+=(-DPROBE_ADDRESS)
  fi
  clang -O0 -g -fsanitize=address,undefined -fno-sanitize-recover=all \
    "-fsanitize-ignorelist=$script_directory/oracle-sanitizer-ignorelist.txt" \
    "${flags[@]}" "$source" -o "$probe_directory/$name"
  local status=0
  "$probe_directory/$name" > "$probe_directory/$name.log" 2>&1 || status=$?
  if [[ $diagnostic == none ]]; then
    if [[ $status != 0 || -s "$probe_directory/$name.log" ]]; then
      cat "$probe_directory/$name.log" >&2
      echo "Expected pinned XS UBSAN probe to be excluded ($name)." >&2
      return 1
    fi
  elif [[ $status == 0 ]] || ! grep -F "$diagnostic" "$probe_directory/$name.log" >/dev/null; then
    cat "$probe_directory/$name.log" >&2
    echo "Expected a failing $diagnostic probe ($name), got exit $status." >&2
    return 1
  fi
  echo "Sanitizer scope: $name passed."
}

check_probe xs-undefined c/moddable/xs/sources/xsRun.c undefined none
check_probe shim-undefined rust/engine/xs-oracle/csrc/xs_shim.c undefined 'runtime error:'
check_probe platform-undefined rust/endo/xsnap/xsnap-platform.c undefined 'runtime error:'
check_probe xs-address c/moddable/xs/sources/xsRun.c address 'AddressSanitizer: heap-buffer-overflow'
check_probe shim-address rust/engine/xs-oracle/csrc/xs_shim.c address 'AddressSanitizer: heap-buffer-overflow'
