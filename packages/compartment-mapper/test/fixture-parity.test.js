// Confirms, on Node.js, that every committed
// `fixtures-<name>/expected-compartment-map.json` golden still matches what
// the pure-JavaScript `@endo/compartment-mapper` implementation produces.
//
// These goldens were introduced to back the rust endor walker's
// fixture-parity ratchet (rust/endo/tests/compartment_mapper_fixture_parity.rs
// diffs endor's output against them). This test closes the loop on the other
// side: it wires the *node* reference oracle into the compartment mapper's own
// ava suite, so a change to the pure-JavaScript mapper that would invalidate a
// golden is caught here — the same drift the standalone
// `rust/endo/tools/gen-parity-golden.mjs --check` catches, but running as part
// of `yarn test` on Node.js rather than a separate manual step.
//
// The oracle (`_parity-oracle.js`) is shared verbatim with that generator, so
// the two cannot disagree about what "the node compartment map for a fixture"
// is. For `oracle: 'node'` fixtures this asserts structural equivalence with
// the committed golden; for `oracle: 'endor-baseline'` fixtures (where
// compartment-mapper does not yield a comparable fixture-local map) it asserts
// the documented divergence still holds, so a mapper change that *removes* the
// divergence is surfaced rather than silently skipped.

import 'ses';
import test from 'ava';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FIXTURES,
  buildNodeGolden,
  checkEndorBaselineDivergence,
  goldenPath,
  serialize,
  stable,
  testRoot,
} from './_parity-oracle.js';

// Guard: the committed goldens on disk and the oracle's FIXTURES table are in
// exact one-to-one correspondence. A golden added without a FIXTURES entry
// would go unchecked here; a FIXTURES entry without a golden would fail its
// own case, but this names the omission directly.
test('every committed golden is accounted for in FIXTURES', t => {
  const onDisk = fs
    .readdirSync(fileURLToPath(testRoot), { withFileTypes: true })
    .filter(
      entry =>
        entry.isDirectory() &&
        entry.name.startsWith('fixtures-') &&
        fs.existsSync(
          `${fileURLToPath(testRoot)}${entry.name}/expected-compartment-map.json`,
        ),
    )
    .map(entry => entry.name.slice('fixtures-'.length))
    .sort();
  const inTable = FIXTURES.map(fix => fix.name).sort();
  t.deepEqual(
    onDisk,
    inTable,
    'committed expected-compartment-map.json goldens must match the oracle FIXTURES table exactly',
  );
});

for (const fix of FIXTURES) {
  if (fix.oracle === 'node') {
    test(`fixtures-${fix.name} golden matches the pure-JS compartment mapper`, async t => {
      const committed = fs.readFileSync(goldenPath(fix.name), 'utf8');
      const live = await buildNodeGolden(fix);
      // Compare the parsed, key-stabilised structures for a readable diff on
      // failure. `stable` matches the canonicalisation the committed file was
      // serialized under, so equal structures compare equal.
      t.deepEqual(
        JSON.parse(committed),
        stable(live),
        `fixtures-${fix.name}: the compartment map produced by @endo/compartment-mapper ` +
          `no longer matches the committed golden. If the mapper changed on purpose, ` +
          `regenerate with \`node rust/endo/tools/gen-parity-golden.mjs ${fix.name}\`.`,
      );
      // Also assert byte-identity with what the generator would write, so
      // formatting/ordering drift cannot slip past the structural compare.
      t.is(
        committed,
        serialize(live),
        `fixtures-${fix.name}: committed golden bytes differ from the freshly serialized map`,
      );
    });
  } else {
    test(`fixtures-${fix.name} endor-baseline divergence from node still holds`, async t => {
      const { held, observed } = await checkEndorBaselineDivergence(fix);
      t.true(
        held,
        `fixtures-${fix.name}: compartment-mapper now yields a fixture-local map ` +
          `(${observed}); promote this fixture to the node oracle and commit its golden. ` +
          `Documented divergence: ${fix.divergence}`,
      );
    });
  }
}
