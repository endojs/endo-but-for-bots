#!/bin/bash
# Regression test for lint-kebab-case-file-names.sh and its pattern-based
# exemptions. Builds a throwaway git repo, drops the real linter in with a
# synthetic exemptions file, and asserts the load-bearing behaviors:
#
#   1. test262 corpus files, including an `_FIXTURE.js` under the vendored
#      directory, are exempted BY PATTERN, not by enumeration;
#   2. a non-kebab file OUTSIDE any exempt pattern is still reported;
#   3. an exact-path exemption still works (back-compat with the old exact list);
#   4. a kebab-cased file under a CAPITALIZED directory is NOT falsely flagged
#      (the capital check reads the base name, not ancestor directories);
#   5. a non-kebab file at the REPOSITORY ROOT is still evaluated (the matcher
#      does not require a leading `/`);
#   6. an all-caps-first-segment name like README.md is left alone.
#   7. the linter finds the repository root when invoked from scripts/.
#
# Run: bash scripts/lint-kebab-case-file-names.test.sh
set -ueo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
linter="$script_directory/lint-kebab-case-file-names.sh"

working_directory="$(mktemp -d)"
trap 'rm -rf "$working_directory"' EXIT
cd "$working_directory"

git init -q
git config user.email test@example.com
git config user.name test

mkdir -p scripts
cp "$linter" scripts/lint-kebab-case-file-names.sh

# Synthetic exemptions exercising each pathspec form.
cat >scripts/lint-kebab-case-exemptions.txt <<'EOF'
# comment lines and blank lines are ignored

# directory prefix: the whole vendored corpus
packages/test262-runner/test262
# glob whose `*` spans `/`: the fixture-naming convention
*_FIXTURE.js
# exact path (back-compat)
packages/marshal/src/rankOrder.js
# exact path at the repository root
RootExact.js
EOF

# Fixtures. Names carrying a capital in the base name are candidates.
mkdir -p packages/test262-runner/test262/harness \
  packages/somepkg/test packages/marshal/src packages/otherpkg/src \
  packages/CapitalDir/src docs
touch \
  packages/test262-runner/test262/harness/compareArray.js \
  packages/test262-runner/test262/harness/compareArray_FIXTURE.js \
  packages/somepkg/test/some_FIXTURE.js \
  packages/marshal/src/rankOrder.js \
  packages/otherpkg/src/badCamelName.js \
  packages/otherpkg/src/good-kebab-name.js \
  packages/CapitalDir/src/good-kebab-name.js \
  docs/README.md \
  rootCamelName.js \
  RootExact.js
git add -A
git commit -qm fixtures

set +e
found="$(cd scripts && bash lint-kebab-case-file-names.sh 2>&1)"
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
expect_report "corpus file exempted by dir prefix" absent \
  packages/test262-runner/test262/harness/compareArray.js
# 1a. a test262 fixture is covered by the directory pattern without being listed
expect_report "test262 _FIXTURE exempted by dir prefix" absent \
  packages/test262-runner/test262/harness/compareArray_FIXTURE.js
# 1b. _FIXTURE OUTSIDE the corpus exempted by the glob (proves `*` spans `/`)
expect_report "_FIXTURE exempted by *_FIXTURE.js glob" absent \
  packages/somepkg/test/some_FIXTURE.js
# 2. genuine non-kebab file outside every pattern still reported
expect_report "non-exempt camelCase file reported" present \
  packages/otherpkg/src/badCamelName.js
# 3. exact-path exemption honored (back-compat)
expect_report "exact-path exemption honored" absent \
  packages/marshal/src/rankOrder.js
# 4. kebab file under a CAPITALIZED directory is NOT falsely flagged
expect_report "kebab file under capitalized dir not flagged" absent \
  packages/CapitalDir/src/good-kebab-name.js
# 4b. a plain kebab file is never flagged
expect_report "plain kebab-case file not reported" absent \
  packages/otherpkg/src/good-kebab-name.js
# 5. a non-kebab file at the repository ROOT is still evaluated...
expect_report "root-level camelCase file reported" present \
  rootCamelName.js
# 5b. ...and a root-level exact exemption still works
expect_report "root-level exact exemption honored" absent \
  RootExact.js
# 6. README.md (all-caps first segment) is left alone
expect_report "README.md not reported" absent \
  docs/README.md

# The genuine violations must make the linter exit non-zero.
if [ "$exit_code" -eq 0 ]; then
  echo "FAIL: linter exited 0 despite non-exempt violations"
  failures=1
else
  echo "ok:   linter exited non-zero on violation (exit $exit_code)"
fi

if [ "$failures" -ne 0 ]; then
  echo "TESTS FAILED"
  exit 1
fi
echo "ALL TESTS PASSED"
