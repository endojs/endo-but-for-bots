/**
 * Drive every XS bundle builder from one command.
 *
 * `yarn bundle:xs` (or `node --run bundle:xs`) runs this script,
 * which in turn runs the three bundlers that generate the XS-side
 * bootstrap sources `rust/endo/xsnap/src/{ses_boot,daemon_bootstrap,
 * worker_bootstrap}.js`.  Those files are gitignored generated
 * artifacts that `rust/endo/xsnap/src/lib.rs` `include_str!`s, so the
 * Rust build cannot proceed without them.
 *
 * Each bundler runs even if an earlier one fails, so one broken
 * bundle does not hide the state of the other two — the failure mode
 * a `&&` chain produced.  The exit status is non-zero if any bundle
 * failed, and the summary names which.
 *
 * Usage: node packages/daemon/scripts/bundle-xs.js
 */
import '@endo/init';

/* eslint-disable no-await-in-loop -- each bundle runs under its own heading */

const bundlers = [
  './bundle-bus-worker-xs-ses-boot.js',
  './bundle-bus-daemon-endor.js',
  './bundle-bus-worker-xs.js',
];

const failures = [];
for (const bundler of bundlers) {
  console.log(`\n=== ${bundler} ===`);
  try {
    // Each bundler is a top-level-await module that writes its
    // output as a side effect of being imported.  Sequential on
    // purpose, so each bundler's log lands under its own heading.
    await import(bundler);
  } catch (error) {
    failures.push(bundler);
    console.error(`${bundler} failed:`, error);
  }
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} of ${bundlers.length} XS bundles failed: ${failures.join(', ')}`,
  );
  process.exitCode = 1;
} else {
  console.log(`\nAll ${bundlers.length} XS bundles written.`);
}
