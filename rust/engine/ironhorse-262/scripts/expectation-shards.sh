#!/usr/bin/env bash
# Shared whole-tree expectation inventory checks. The sweep and shell regression
# tests source this file; it deliberately does not change caller shell options.

expectation_shard_name() {
  local filename
  filename=$("$3" batch-filename "$2") || return 1
  printf '%s/%s.txt\n' "$1" "${filename%.json}"
}

# Bind a committed shard directory to exactly the discovered batch plan. Checking
# only the files a worker happens to open would miss deleted or added batches.
validate_expectation_shards() {
  local directory="$1" discovery="$2" report_tool="$3"
  local expected actual batch shard file result=0
  if ! cmp -s "$directory/manifest.txt" "$discovery"; then
    echo "expectations: batch manifest differs from discovery (missing, new, or reordered batches)" >&2
    return 1
  fi
  expected=$(mktemp) || return 1
  actual=$(mktemp) || { rm -f "$expected"; return 1; }
  printf '%s\n' manifest.txt > "$expected"
  while IFS= read -r batch; do
    [ -n "$batch" ] || continue
    shard=$(expectation_shard_name "$directory" "$batch" "$report_tool") || { result=1; break; }
    printf '%s\n' "${shard##*/}" >> "$expected"
    if [ ! -f "$shard" ]; then
      echo "expectations: missing shard $shard" >&2
      result=1
    fi
  done < "$discovery"
  for file in "$directory"/*.txt; do
    [ -f "$file" ] && printf '%s\n' "${file##*/}"
  done | LC_ALL=C sort > "$actual"
  LC_ALL=C sort -o "$expected" "$expected"
  if ! cmp -s "$expected" "$actual"; then
    echo "expectations: shard inventory differs from manifest" >&2
    result=1
  fi
  rm -f "$expected" "$actual"
  return "$result"
}

# Resume identity includes baseline content: changing a list must never reuse
# results scored against an older list from the same engine/corpus checkout.
expectation_shards_digest() {
  local directory="$1" file LC_ALL=C
  {
    for file in "$directory"/*.txt; do
      [ -f "$file" ] || continue
      printf '%s\n' "${file##*/}"
      cat "$file" || return 1
    done
  } | if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}
