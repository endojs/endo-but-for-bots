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
// Today endor's guest `lockdown()`/`Compartment` surface is a named scope
// fold (only the host-side realm API + guest `harden`/`petrify` are landed),
// so every ses-xs-parity case reports an HONEST named skip
// (`feature:Compartment` / `ses-mode:lockdown-unimplemented`) and the run is
// green with zero failures. Coverage lights up automatically when that guest
// surface lands — no change to this wiring. Prerequisite (as for the xs
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
