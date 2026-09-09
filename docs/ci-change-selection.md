# CI change selection

Pull-request and push workflows call `.github/workflows/ci-changes.yml` before
allocating test runners or expanding their platform matrices.
The detector in `scripts/ci-changes.py` emits a JSON job selection and a list of
affected JavaScript workspace names.
Nightly fuzzing, full test262 sweeps, and their benchmarks retain their scheduled
and manual triggers.
The browser workflow also retains its daily full run.

For a pull request, the detector compares its head with the merge base of its
actual target branch.
For a push, including a branch update produced by merging a pull request, it
compares the event's `before` and `after` commits.
It reads the complete Git diff, without the changed-files API's truncation limit.
Rename detection is disabled so both the old and new owners are considered.
A newly created branch selects against its entire tree.

The detector reads dependency graphs from both ends of that comparison and from
the actual checkout used by the test jobs.
For PRs, that checkout is the synthetic merge commit, which also covers consumers
and dependency edges added on the target branch since the PR forked.
A package is affected when it changes or when a recursive dependency changes,
including dependencies used by tests and build tools.
Using both graphs preserves the affected consumers of removed packages and
removed dependency edges.
JavaScript edges come from workspace manifests; Rust edges come from local path
dependencies, including build, development, target-specific, and inherited
workspace dependencies.
Explicit edges cover bundles and engines that cross the JavaScript/Rust/C boundary
or use repository paths absent from package manifests.

Shared installation and tool configuration, such as the root Yarn manifest and
lockfile, conservatively invalidates the jobs that use that toolchain.
Workflow and harness changes select their own checks.
Changes to the detector or task runner select all checks so CI validates the
selection machinery itself.
Ironhorse's nightly expectation baselines and benchmark scripts do not select
unrelated PR test suites.

`scripts/run-ci-task.py` passes exact affected workspace names to Turbo for
runtime, coverage, XS, and type-contract tests.
Turbo still builds the selected tasks' prerequisites.
An empty list, or a selection with no implementation of the requested task,
does not invoke Turbo: an unfiltered invocation would run every package.
Malformed names and unknown workspaces fail rather than broadening the selection.

Documentation validation lives in the main lint job.
The separate docs workflow is unnecessary because the main workflow now starts
for every PR and makes its skip decisions at job level.
Dependent checks explicitly fail if the detector fails; an unavailable change
range is never interpreted as an empty affected set.
The old `test262` job has been removed because it only installed dependencies and
built the repository before executing `exit 0`.
The real hardened262 baseline remains in the affected XS suite.

When adding a test job, register its package or crate roots and any non-manifest
inputs in the detector, then wire its job-level condition to the returned flag.
Add regression cases showing both relevant and unrelated changes.
When adding a new bundle entry point or generated artifact, check whether it
requires a new explicit dependency edge.

Run the selector and task-runner regression suites locally with:

```sh
python3 scripts/test-ci-changes.py
python3 scripts/test-run-ci-task.py
```

The detector requires Python 3.11 or later for the standard-library TOML parser;
its workflow pins Python 3.12.
