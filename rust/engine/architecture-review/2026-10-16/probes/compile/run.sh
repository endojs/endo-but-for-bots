#!/bin/bash
# shellcheck disable=SC2034
# Run each probe file in $1 (or the given files) on ironhorse-xst and node.
XST=/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst
NODE=/opt/node22/bin/node
for f in "$@"; do
  name=$(basename "$f" .js)
  start=$(date +%s.%N)
  ih=$(timeout 120 "$XST" "$f" 2>&1 >/dev/null | head -c 300 | tr '\n' ' ')
  ihc=${PIPESTATUS[0]}
  end=$(date +%s.%N)
  nd=$(timeout 60 "$NODE" --stack-size=984 "$f" 2>&1 >/dev/null | grep -E '^[A-Za-z]*Error' | head -1 | head -c 200)
  printf '%-16s ih[%.2fs]: %s | node: %s\n' "$name" "$(echo "$end - $start" | bc)" "${ih:-OK}" "${nd:-OK}"
done
