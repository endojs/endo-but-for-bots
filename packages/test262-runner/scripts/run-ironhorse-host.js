// Run Ironhorse — the Rust XS→Rust port — as the third `test262-runner` host on
// the `ses-xs-parity` axis, alongside `xst` (`test262:xs`) and node
// (`test262:node`). Where those two drive the checked-in subset through the
// npm `test262-harness` with a SES prelude, Ironhorse drives the SAME subset
// through its own `endot-ih` runner (design
// `designs/ironhorse-test262-convergence.md` § Part 2 + § Staging step
// 4): the xst-analogue runner already walks this tree, so joining the parity
// axis is one lockdown-mode invocation filtered to the `ses-xs-parity`
// feature.
//
// endot-ih is a Rust binary in the engine workspace (`rust/engine`), so this
// wrapper builds it with cargo and runs it over `test262/` with:
//   -l                         the SES lockdown mode (xst262.c's `-l`), the
//                              engine-side analogue of the SES prelude xs/node
//                              load;
//   --feature-filter ses-xs-parity   run ONLY the ses-xs-parity-marked cases
//                              (the `test262-harness --features-include`
//                              semantics the xs/node scripts use);
//   --features-include ses-xs-parity opt that feature out of endot-ih's own
//                              not-implemented skip list so the cases are
//                              attempted rather than pre-skipped on the marker.
//
// `-l` used to FAIL CLOSED here: the guest `lockdown()`/`Compartment` surface
// was a named scope fold, so `endot-ih` refused to start and this script
// exited nonzero rather than pre-skipping every case and exiting 0 — a lane
// that records nothing while looking like a passing third host. That is not a
// CI gate either way; the `ses-xs-parity` axis is a ratchet and fails no build
// (see the package README, "Ratchet, not a gate"). It is that a ratchet is
// only worth the number it records.
//
// The guest `lockdown()` has since landed, so the lane starts and reports a
// real number: 0 of 8 covered, 8 named skips. Two skip on
// `feature:Compartment`, which is still a scope fold; the other six want
// globals (`frozenBytes`, `compareBytes`, `concatBytes`, `passStyleOf`,
// `environment`) that no engine has natively, so ironhorse and the XS oracle
// fail them identically — agreement, hence a skip rather than a divergence.
// The package README's § The engine lane's zero has the breakdown. For a
// compatibility count today, use `test262:ironhorse-host`, which drives
// ironhorse as a plain test262 host with no oracle.
// Prerequisite (as for the xs
// host's `xst`): the `c/moddable` submodule for the XS oracle and a Rust
// toolchain; `cargo` must be on PATH.

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const packageRoot = new URL('..', import.meta.url);
const repoRoot = new URL('../../', packageRoot);
const engineDir = fileURLToPath(new URL('rust/engine', repoRoot));
const test262Dir = fileURLToPath(new URL('test262', packageRoot));

const run = (command, args, cwd) => {
  console.error(`+ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    process.exit(127);
  }
  return result.status ?? 1;
};

// Build once (release, so a whole-tree walk is not debug-slow), then run.
const buildStatus = run(
  'cargo',
  ['build', '--release', '--quiet', '-p', 'ironhorse-262', '--bin', 'endot-ih'],
  engineDir,
);
if (buildStatus !== 0) {
  process.exit(buildStatus);
}

// Subtrees to walk: default to the whole checked-in tree so any ses-xs-parity
// case anywhere is picked up; a caller may pass explicit subtrees through.
const subtrees = process.argv.slice(2);
const runStatus = run(
  'cargo',
  [
    'run',
    '--release',
    '--quiet',
    '-p',
    'ironhorse-262',
    '--bin',
    'endot-ih',
    '--',
    '-l',
    '--feature-filter',
    'ses-xs-parity',
    '--features-include',
    'ses-xs-parity',
    '--test262-dir',
    test262Dir,
    ...(subtrees.length ? subtrees : ['built-ins', 'language']),
  ],
  engineDir,
);
process.exit(runStatus);
