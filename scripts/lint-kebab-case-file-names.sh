#!/bin/bash
# Fail when a tracked file's name is not kebab-case, unless it is exempted in
# scripts/lint-kebab-case-exemptions.txt. Wired into CI so exceptions to the
# convention are evident in CI and in PR diffs.
#
# Each exemption line is a git pathspec (default magic), so a single entry can
# name an exact path, a directory prefix (matching every file beneath it), or a
# glob in which `*` also spans `/`. That lets whole vendored trees -- notably the
# ~9.7k-file test262 corpus, which is not under our control -- be exempted with a
# couple of patterns instead of an enumerated, impossible-to-review dump.
#
# The name check itself is deliberately loose: it flags a file whose base name
# has a "wordy" first dot-segment (one containing a lowercase letter, so a name
# like README.md or LICENSE-v8 is left alone) together with a capital letter
# somewhere in that base name. The capital and the wordiness are tested on the
# base name only -- never on ancestor directory names -- so a kebab-cased file
# under a capitalized directory is not falsely flagged, and a file at the
# repository root is checked like any other. A stricter checker would also reject
# the `_` currently tolerated in many names; that is left for later.
set -ueo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(git -C "$script_directory" rev-parse --show-toplevel)"
cd "$repository_root"

exemptions_path=scripts/lint-kebab-case-exemptions.txt

# Turn each non-blank, non-comment exemption line into a git exclude pathspec.
exclude_pathspecs=()
while IFS= read -r pattern || [ -n "$pattern" ]; do
  case "$pattern" in
  '' | '#'*) continue ;;
  esac
  exclude_pathspecs+=(":(exclude)$pattern")
done <"$exemptions_path"

# Tracked files that violate the convention and match no exemption pathspec. The
# positive `*` pathspec selects every tracked file; the excludes subtract the
# exemptions; awk applies the name check to each path's base name alone.
function violators() {
  git ls-files -- '*' "${exclude_pathspecs[@]}" |
    awk -F/ '
      {
        base = $NF                       # the name after the last "/"
        if (substr(base, 1, 1) == ".") next   # ignore dotfiles
        segment = base
        sub(/\..*/, "", segment)         # the first dot-delimited part of the name
        if (segment ~ /[a-z]/ && base ~ /[A-Z]/) print
      }
    ' |
    sort
}

# Report and fail if any violator survives.
found="$(violators)"
if [ -n "$found" ]; then
  printf '%s\n' "$found" >&2
  echo >&2
  echo "The above file names must be kebab-case or added to $exemptions_path" >&2
  exit 1
fi
