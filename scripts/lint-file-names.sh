#!/bin/bash
# Fail when a tracked file's name has mixed ASCII case, unless it is exempted in
# scripts/lint-file-names-exemptions.txt. Wired into CI so exceptions to the
# convention are evident in PR diffs.
#
# Each exemption line is a git pathspec (default magic), so a single entry can
# name an exact path, a directory prefix (matching every file beneath it), or a
# glob in which `*` also spans `/`. This keeps vendored trees such as test262 out
# of the checked-in exemption list without enumerating their files.
#
# The deliberately narrow check applies to file base names, not directories. It
# flags a word-like first dot-segment containing an ASCII lowercase letter when
# the base name also contains an ASCII uppercase letter. All-uppercase segments,
# non-ASCII case, and underscores are outside this check's scope.
set -ueo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(git -C "$script_directory" rev-parse --show-toplevel)"
cd "$repository_root"

# Pin default pathspec semantics even when the caller has configured Git through
# its environment. Otherwise GIT_LITERAL_PATHSPECS=1 makes `*` select no files.
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS \
  GIT_ICASE_PATHSPECS

exemptions_path=scripts/lint-file-names-exemptions.txt

# Turn each non-blank, non-comment exemption line into a git exclude pathspec.
exclude_pathspecs=()
while IFS= read -r pattern || [ -n "$pattern" ]; do
  pattern="${pattern%$'\r'}"
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
    LC_ALL=C awk -F/ '
      {
        base = $NF                       # the name after the last "/"
        if (substr(base, 1, 1) == ".") next   # ignore dotfiles
        segment = base
        sub(/\..*/, "", segment)         # the first dot-delimited part of the name
        if (segment ~ /[[:lower:]]/ && base ~ /[[:upper:]]/) print
      }
    ' |
    sort
}

# Report and fail if any violator survives.
found="$(violators)"
if [ -n "$found" ]; then
  printf '%s\n' "$found" >&2
  echo >&2
  echo "The above file names must avoid mixed ASCII case or be added to $exemptions_path" >&2
  exit 1
fi
