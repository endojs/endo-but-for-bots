#!/usr/bin/env bash
# Create or remove a lane: one git worktree per independent line of work on
# the Thixotrope harness (designs/process.md section 1).
#
# Usage:
#   scripts/new-lane.sh NAME [BASE]
#   scripts/new-lane.sh --remove NAME [INTO]
#
# NAME is lower-case letters, digits and dashes. A lane is the worktree
# "<parent of this worktree>/endo-thix-NAME" on branch "claude/thix-NAME",
# cut from BASE (default claude/thixotrope-harness, the main harness branch).
#
# Create runs these steps and prints the time each took:
#   1. worktree  `git worktree add` (skipped when the lane already exists)
#   2. install   `corepack yarn install --immutable` in the lane
#   3. worker    the release Ironhorse worker, without cargo (below)
#   4. bundles   the Ironhorse boot bundles (packages/thixotrope/dist-ironhorse)
# It is idempotent: run it again on an existing lane to bring the install,
# the worker link and the bundles up to date. It refuses a directory that
# exists but is not that lane's worktree on that branch.
#
# The worker. The test template helper and scripts/serve.mjs run
# THIXOTROPE_IRONHORSE_WORKER, else <repo>/target/release/thixotrope-ironhorse-worker.
# The script copies the source binary once per content into
# "$THIX_HARNESS_HOME/worker/<sha256 prefix>/" (default THIX_HARNESS_HOME:
# ~/.cache/thixotrope-harness) and links the lane's
# target/release/thixotrope-ironhorse-worker to that copy. So the default
# lookup works in the lane with no environment, every lane with the same
# worker shares one 11 MB file, and a rebuild of the source worktree's worker
# never changes a binary under a lane's running test (the copy is immutable;
# its directory name says which worker it is). The source is
# THIXOTROPE_IRONHORSE_WORKER when set, else the release worker of the
# worktree that has claude/thixotrope-harness checked out, else this one.
# A lane that builds its own worker with cargo (only the core lane may)
# replaces the link with a real file; the script then leaves it alone.
#
# The boot bundles are built into a scratch directory and moved into place
# only when they differ (a change under a running test would break it).
# Guest program bundles are made in process by the tests (bundleGuest), so
# they need no step here.
#
# Remove refuses unless the lane's branch is fully merged into INTO (default
# claude/thixotrope-harness) and the lane has no uncommitted or untracked
# files; then it removes the worktree (node_modules and tmp/ with it) and
# deletes the branch. The shared worker copies stay.

set -euo pipefail

MAIN_BRANCH=claude/thixotrope-harness
WORKER_NAME=thixotrope-ironhorse-worker

die() {
  echo "new-lane: $*" >&2
  exit 1
}

usage() {
  sed -n '4,6p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

STEP_NAME=''
STEP_START=0
step() {
  step_end
  STEP_NAME=$1
  STEP_START=$(now_ms)
  echo "== $STEP_NAME"
}
step_end() {
  if [ -n "$STEP_NAME" ]; then
    local end
    end=$(now_ms)
    node -e 'const [n, a, b] = process.argv.slice(1);
      console.log(`== ${n}: ${((b - a) / 1000).toFixed(1)} s`);' \
      "$STEP_NAME" "$STEP_START" "$end"
    STEP_NAME=''
  fi
}

here=$(cd "$(dirname "$0")" && pwd -P)
self_top=$(git -C "$here" rev-parse --show-toplevel)
parent=$(dirname "$self_top")
harness_home=${THIX_HARNESS_HOME:-$HOME/.cache/thixotrope-harness}

remove=0
if [ "${1:-}" = "--remove" ]; then
  remove=1
  shift
fi
[ $# -ge 1 ] && [ $# -le 2 ] || usage
name=$1
target_ref=${2:-$MAIN_BRANCH}
case $name in
  '' | -* | *[!a-z0-9-]*) die "NAME must be lower-case letters, digits and dashes: $name" ;;
esac

lane="$parent/endo-thix-$name"
branch="claude/thix-$name"

# The branch a registered worktree at $1 has checked out ("" if none, or not
# registered).
worktree_branch() {
  git -C "$self_top" worktree list --porcelain | awk -v want="$1" '
    $1 == "worktree" { path = substr($0, 10) }
    $1 == "branch" && path == want { sub("refs/heads/", "", $2); print $2 }
  '
}

# The worktree that has branch $1 checked out ("" if none).
worktree_of_branch() {
  git -C "$self_top" worktree list --porcelain | awk -v want="refs/heads/$1" '
    $1 == "worktree" { path = substr($0, 10) }
    $1 == "branch" && $2 == want { print path }
  '
}

# Refuse a directory that exists but is not this lane.
check_is_lane() {
  local real got
  real=$(cd "$lane" && pwd -P)
  got=$(worktree_branch "$real")
  [ "$got" = "$branch" ] ||
    die "$lane exists but is not the worktree of $branch (branch: ${got:-none}); not touching it"
}

if [ "$remove" = 1 ]; then
  [ -d "$lane" ] || die "no lane at $lane"
  check_is_lane
  [ "$(cd "$lane" && pwd -P)" != "$self_top" ] || die "refusing to remove the worktree this script runs from"
  git -C "$self_top" rev-parse --verify --quiet "refs/heads/$target_ref" >/dev/null ||
    die "no branch $target_ref to check the merge against"
  if ! git -C "$self_top" merge-base --is-ancestor "$branch" "$target_ref"; then
    ahead=$(git -C "$self_top" rev-list --count "$target_ref..$branch")
    die "$branch has $ahead commit(s) not in $target_ref; merge it first"
  fi
  dirty=$(git -C "$lane" status --porcelain --untracked-files=all)
  [ -z "$dirty" ] || die "$lane has uncommitted or untracked files:
$dirty"
  step "remove worktree"
  git -C "$self_top" worktree remove "$lane"
  step "delete branch"
  # Merged into $target_ref, checked above; -d would check against HEAD.
  git -C "$self_top" branch -D "$branch"
  step_end
  echo "removed lane $name"
  exit 0
fi

base=$target_ref
total_start=$(now_ms)

# 1. The worktree.
step "worktree"
if [ -e "$lane" ]; then
  [ -d "$lane" ] || die "$lane exists and is not a directory"
  check_is_lane
  echo "lane exists at $lane on $branch"
elif git -C "$self_top" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
  echo "branch $branch exists; checking it out at $lane"
  git -C "$self_top" worktree add "$lane" "$branch"
else
  git -C "$self_top" rev-parse --verify --quiet "$base^{commit}" >/dev/null ||
    die "no base $base"
  git -C "$self_top" worktree add -b "$branch" "$lane" "$base"
fi

# 2. Dependencies.
step "install"
(cd "$lane" && corepack yarn install --immutable)

# 3. The worker.
step "worker"
if [ -n "${THIXOTROPE_IRONHORSE_WORKER:-}" ]; then
  source_worker=$THIXOTROPE_IRONHORSE_WORKER
else
  main_tree=$(worktree_of_branch "$MAIN_BRANCH")
  source_worker="${main_tree:-$self_top}/target/release/$WORKER_NAME"
  [ -f "$source_worker" ] || source_worker="$self_top/target/release/$WORKER_NAME"
fi
lane_worker="$lane/target/release/$WORKER_NAME"
if [ -f "$lane_worker" ] && [ ! -L "$lane_worker" ]; then
  echo "the lane has its own worker build; leaving $lane_worker alone"
else
  [ -f "$source_worker" ] ||
    die "no worker at $source_worker; set THIXOTROPE_IRONHORSE_WORKER or build it in the core lane"
  digest=$(shasum -a 256 "$source_worker" | awk '{print $1}')
  cache_dir="$harness_home/worker/${digest:0:16}"
  cached="$cache_dir/$WORKER_NAME"
  if [ ! -f "$cached" ]; then
    mkdir -p "$cache_dir"
    cp -p "$source_worker" "$cached.part.$$"
    chmod 0555 "$cached.part.$$"
    got=$(shasum -a 256 "$cached.part.$$" | awk '{print $1}')
    [ "$got" = "$digest" ] || die "the worker changed while it was copied; run again"
    mv -f "$cached.part.$$" "$cached"
  fi
  mkdir -p "$lane/target/release"
  ln -sfn "$cached" "$lane_worker"
  echo "worker ${digest:0:16} (sha256 $digest)"
fi

# 4. The Ironhorse boot bundles.
step "bundles"
thix="$lane/packages/thixotrope"
scratch="$thix/tmp/new-lane-bundles.$$"
mkdir -p "$scratch"
trap 'rm -rf "$scratch"' EXIT
(cd "$thix" && node scripts/bundle-ironhorse-worker.mjs "$scratch" >/dev/null)
dist="$thix/dist-ironhorse"
mkdir -p "$dist"
changed=0
for file in "$scratch"/*; do
  name_only=$(basename "$file")
  if ! cmp -s "$file" "$dist/$name_only"; then
    mv -f "$file" "$dist/$name_only"
    changed=1
  fi
done
if [ "$changed" = 1 ]; then
  echo "boot bundles written (a running test in this lane would see new bundles)"
else
  echo "boot bundles up to date"
fi

step_end
total_end=$(now_ms)
node -e 'const [a, b] = process.argv.slice(1);
  console.log(`lane ready in ${((b - a) / 1000).toFixed(1)} s`);' \
  "$total_start" "$total_end"
echo "lane:   $lane"
echo "branch: $branch"
echo "worker: $lane_worker"
