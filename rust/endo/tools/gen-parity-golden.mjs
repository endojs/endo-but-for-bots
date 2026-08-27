// Parity-golden generator for the endor↔node compartment-mapper
// fixture-parity ratchet (designs/endor-run-expanded.md,
// § Fixture-parity ratchet).
//
// This is a thin CLI over the shared *node reference oracle*, which now
// lives beside the fixtures it describes at
//
//     packages/compartment-mapper/test/_parity-oracle.js
//
// The oracle imports `@endo/compartment-mapper` directly and serializes a
// stable, structural projection of each fixture's compartment map to
//
//     packages/compartment-mapper/test/fixtures-<name>/expected-compartment-map.json
//
// This generator only (re)writes and `--check`s those committed goldens; the
// projection rules, fixture table, and provenance taxonomy are documented on
// the oracle module. The compartment mapper's own ava suite
// (packages/compartment-mapper/test/fixture-parity.test.js) imports the same
// oracle to confirm, on Node.js, that every committed golden still matches
// the pure-JavaScript implementation — so the generator and the ava test can
// never disagree about what "the node compartment map for a fixture" is.
//
// The rust parity harness
// (rust/endo/tests/compartment_mapper_fixture_parity.rs) diffs endor's
// walker output against the same committed golden, upgrading the former
// compartment-*count* assertion to a *structural* one. Because the oracle is
// a plain module (no ava, no fixture harness), it can be regenerated in CI
// and diffed to catch reference drift when `@endo/compartment-mapper` itself
// changes.
//
// Usage (from the repo root):
//
//     node rust/endo/tools/gen-parity-golden.mjs           # regenerate all
//     node rust/endo/tools/gen-parity-golden.mjs --check    # fail on drift, write nothing
//     node rust/endo/tools/gen-parity-golden.mjs cthuloops  # a subset by name

import 'ses';

lockdown({ errorTaming: 'unsafe' });

import fs from 'node:fs';

// The oracle statically imports `@endo/compartment-mapper` subpaths (which
// harden at evaluation), so it is imported dynamically *after* lockdown.
const {
  FIXTURES,
  buildNodeGolden,
  checkEndorBaselineDivergence,
  goldenPath,
  serialize,
} = await import('../../../packages/compartment-mapper/test/_parity-oracle.js');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const names = args.filter(a => !a.startsWith('--'));
const selected = names.length
  ? FIXTURES.filter(f => names.includes(f.name))
  : FIXTURES;

let drift = 0;
for (const fix of selected) {
  const gPath = goldenPath(fix.name);

  if (fix.oracle === 'node') {
    const text = serialize(await buildNodeGolden(fix));
    const prior = fs.existsSync(gPath) ? fs.readFileSync(gPath, 'utf8') : null;
    if (prior === text) {
      console.log(`ok    ${fix.name} (node oracle, unchanged)`);
    } else if (checkOnly) {
      drift += 1;
      console.error(`DRIFT ${fix.name} (node oracle golden is stale)`);
    } else {
      fs.writeFileSync(gPath, text);
      console.log(`write ${fix.name} (node oracle)`);
    }
    continue;
  }

  // endor-baseline: verify the documented node divergence still holds,
  // and leave the committed golden (authored from endor's own output)
  // untouched.
  const { held, observed } = await checkEndorBaselineDivergence(fix);
  if (!held) {
    drift += 1;
    console.error(
      `DRIFT ${fix.name} (endor-baseline divergence no longer holds: ${observed}) — ` +
        `compartment-mapper now yields a fixture-local map; promote this fixture to the node oracle.`,
    );
  } else if (!fs.existsSync(gPath)) {
    drift += 1;
    console.error(
      `MISSING ${fix.name} (endor-baseline golden absent at ${gPath})`,
    );
  } else {
    console.log(`skip  ${fix.name} (endor-baseline; ${observed})`);
  }
}

if (checkOnly && drift > 0) {
  console.error(
    `\n${drift} golden(s) drifted; run without --check to regenerate.`,
  );
  process.exit(1);
}
if (!checkOnly && drift > 0) {
  process.exit(1);
}
