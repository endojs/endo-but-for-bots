// Always an ECMAScript module (`.mts`), regardless of any enclosing `type`.
// Aggregates one module per ts/mts/cts classification case so the test can
// assert the whole subtree parsed under the language Node.js would choose.
import rootTs from './root.ts';
import alwaysMts from './always.mts';
import ctsLeaf from './cjs-sub/leaf.ts';
import alwaysCts from './cjs-sub/always.cts';
import forcedMts from './cjs-sub/forced.mts';
import ctsDeep from './cjs-sub/deep/again.ts';
import tsEsmAgain from './cjs-sub/esm-again/remod.ts';

export default {
  rootTs,
  alwaysMts,
  ctsLeaf,
  alwaysCts,
  forcedMts,
  ctsDeep,
  tsEsmAgain,
};
