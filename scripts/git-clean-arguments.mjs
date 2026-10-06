/**
 * @file The `git clean` arguments shared by `scripts/pack-all.mjs` and the
 * root `clean` script in `package.json`.
 *
 * `.yarn/install-state.gz` is an ignored file (via `.yarn/*`), so only a
 * negated exclude exempts it; without it every subsequent `yarn run` reports
 * the project as not installed.  `node_modules/` survives because `-fX`
 * without `-d` never removes an ignored directory; the plain `-e node_modules`
 * only restates `.gitignore`.  Never add `-d`: it would delete the install.
 *
 * `scripts/git-clean-arguments.test.mjs` pins this behavior.
 */

export const gitCleanArguments = Object.freeze([
  'clean',
  '-fX',
  '-e',
  'node_modules',
  '-e',
  '!.yarn/install-state.gz',
]);
