#!/bin/bash
# Regression test for lint-file-names.sh and its pattern-based
# exemptions. Builds a throwaway git repo, drops the real linter in with a
# synthetic exemptions file, and asserts the load-bearing behaviors:
#
#   1. test262 corpus files, including an `_FIXTURE.js` under the vendored
#      directory, are exempted BY PATTERN, not by enumeration;
#   2. a mixed-case file OUTSIDE any exempt pattern is still reported;
#   3. an exact-path exemption works;
#   4. a lowercase file under a CAPITALIZED directory is NOT falsely flagged
#      (the capital check reads the base name, not ancestor directories);
#   5. a mixed-case file at the REPOSITORY ROOT is still evaluated (the matcher
#      does not require a leading `/`);
#   6. an all-caps-first-segment name like README.md is left alone;
#   7. the linter finds the repository root when invoked from scripts/;
#   8. caller-provided Git pathspec environment variables cannot disable it;
#   9. CRLF-terminated exemption lines are accepted.
#
# Run: bash scripts/lint-file-names.test.sh
set -ueo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
linter="$script_directory/lint-file-names.sh"

working_directory="$(mktemp -d)"
trap 'rm -rf "$working_directory"' EXIT
cd "$working_directory"

git init -q
git config user.email test@example.com
git config user.name test

mkdir -p scripts
cp "$linter" scripts/lint-file-names.sh

# Synthetic exemptions exercising each pathspec form.
cat >scripts/lint-file-names-exemptions.txt <<'EOF'
# comment lines and blank lines are ignored

# directory prefix: the whole vendored corpus
packages/test262-runner/test262
# glob whose `*` spans `/`: the fixture-naming convention
*_FIXTURE.js
# exact path
packages/marshal/src/rankOrder.js
# exact path at the repository root
RootExact.js
EOF
printf '%s\r\n' 'packages/otherpackage/src/WindowsExact.js' \
  >>scripts/lint-file-names-exemptions.txt

# Fixtures. Names carrying a capital in the base name are candidates.
mkdir -p packages/test262-runner/test262/harness \
  packages/somepackage/test packages/marshal/src packages/otherpackage/src \
  packages/CapitalDirectory/src docs
touch \
  packages/test262-runner/test262/harness/compareArray.js \
  packages/test262-runner/test262/harness/compareArray_FIXTURE.js \
  packages/somepackage/test/some_FIXTURE.js \
  packages/marshal/src/rankOrder.js \
  packages/otherpackage/src/badCamelName.js \
  packages/otherpackage/src/good-kebab-name.js \
  packages/otherpackage/src/WindowsExact.js \
  packages/CapitalDirectory/src/good-kebab-name.js \
  docs/LICENSE-local \
  docs/README.md \
  rootCamelName.js \
  RootExact.js
git add -A
git commit -qm fixtures

set +e
found="$(
  cd scripts &&
    GIT_LITERAL_PATHSPECS=1 \
      GIT_GLOB_PATHSPECS=1 \
      GIT_NOGLOB_PATHSPECS=1 \
      GIT_ICASE_PATHSPECS=1 \
      bash lint-file-names.sh 2>&1
)"
exit_code=$?
set -e

failures=0
expect_report() { # description  present|absent  needle
  local description="$1" mode="$2" needle="$3"
  if printf '%s\n' "$found" | grep -qF -- "$needle"; then
    if [ "$mode" = present ]; then echo "ok:   $description"; else
      echo "FAIL: $description -- '$needle' should NOT be reported"; failures=1; fi
  else
    if [ "$mode" = absent ]; then echo "ok:   $description"; else
      echo "FAIL: $description -- '$needle' should be reported"; failures=1; fi
  fi
}

echo "--- linter output (exit $exit_code) ---"
printf '%s\n' "$found"
echo "--------------------------------------"

# 1. corpus file exempted by directory prefix
expect_report "corpus file exempted by directory prefix" absent \
  packages/test262-runner/test262/harness/compareArray.js
# 1a. a test262 fixture is covered by the directory pattern without being listed
expect_report "test262 _FIXTURE exempted by directory prefix" absent \
  packages/test262-runner/test262/harness/compareArray_FIXTURE.js
# 1b. _FIXTURE OUTSIDE the corpus exempted by the glob (proves `*` spans `/`)
expect_report "_FIXTURE exempted by *_FIXTURE.js glob" absent \
  packages/somepackage/test/some_FIXTURE.js
# 2. genuine mixed-case file outside every pattern still reported
expect_report "non-exempt camelCase file reported" present \
  packages/otherpackage/src/badCamelName.js
# 3. exact-path exemption honored
expect_report "exact-path exemption honored" absent \
  packages/marshal/src/rankOrder.js
# 3b. a CRLF-terminated exact exemption is normalized before matching
expect_report "CRLF exact-path exemption honored" absent \
  packages/otherpackage/src/WindowsExact.js
# 4. lowercase file under a CAPITALIZED directory is NOT falsely flagged
expect_report "lowercase file under capitalized directory not flagged" absent \
  packages/CapitalDirectory/src/good-kebab-name.js
# 4b. a plain lowercase file is never flagged
expect_report "plain lowercase file not reported" absent \
  packages/otherpackage/src/good-kebab-name.js
# 5. a mixed-case file at the repository ROOT is still evaluated...
expect_report "root-level camelCase file reported" present \
  rootCamelName.js
# 5b. ...and a root-level exact exemption still works
expect_report "root-level exact exemption honored" absent \
  RootExact.js
# 6. README.md (all-caps first segment) is left alone
expect_report "README.md not reported" absent \
  docs/README.md
# 6b. a mixed-case name without a dot is still in scope
expect_report "mixed-case extensionless file reported" present \
  docs/LICENSE-local

# The genuine violations must make the linter exit non-zero.
if [ "$exit_code" -eq 0 ]; then
  echo "FAIL: linter exited 0 despite non-exempt violations"
  failures=1
else
  echo "ok:   linter exited non-zero on violation (exit $exit_code)"
fi

# Once every genuine violation is explicitly exempted, the same invocation from
# scripts/ must inspect the tree and exit successfully.
printf '%s\n' \
  'packages/otherpackage/src/badCamelName.js' \
  'docs/LICENSE-local' \
  'rootCamelName.js' \
  >>scripts/lint-file-names-exemptions.txt
if (cd scripts && GIT_LITERAL_PATHSPECS=1 bash lint-file-names.sh); then
  echo "ok:   linter exits 0 on a fully clean tree"
else
  echo "FAIL: linter did not exit 0 on a fully clean tree"
  failures=1
fi

if [ "$failures" -ne 0 ]; then
  echo "TESTS FAILED"
  exit 1
fi
echo "ALL TESTS PASSED"
