// @ts-nocheck
// Shared assertions for the auxiliary-`package.json` TypeScript-extension parity
// pair. `auxiliary-typescript.test.js` loads the fixture through the Compartment
// Mapper; `auxiliary-typescript-node-parity.test.js` loads an equivalent tree
// under plain Node.js. Both call `assertTypeScriptClassification` on the
// aggregate `default` export, so the two resolvers are checked against one set
// of expected values and parity holds by construction: if both pass, the
// Compartment Mapper classifies `.ts`/`.mts`/`.cts` exactly as Node.js does.
//
// The aggregate keys correspond to the `ts-pkg` fixture's classification cases:
//
//   rootTs     `.ts` under ts-pkg's own `type: "module"`     -> ECMAScript (mts)
//   alwaysMts  `.mts`                                         -> always ECMAScript
//   ctsLeaf    `.ts` under a `{"type":"commonjs"}` auxiliary  -> CommonJS (cts)
//   alwaysCts  `.cts`                                         -> always CommonJS
//   forcedMts  `.mts` inside the commonjs subtree             -> stays ECMAScript
//   ctsDeep    `.ts` in a deeper dir with no package.json     -> inherits CommonJS
//   tsEsmAgain `.ts` under a still-deeper `{"type":"module"}` -> back to ECMAScript

const expected = {
  rootTs: 'root-ts-esm',
  alwaysMts: 'mts-esm',
  ctsLeaf: 'cts-leaf',
  alwaysCts: 'cts-always',
  forcedMts: 'mts-under-cjs',
  ctsDeep: 'cts-deep',
  tsEsmAgain: 'ts-esm-again',
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, string>} aggregate the `ts-pkg` default export
 */
export const assertTypeScriptClassification = (t, aggregate) => {
  t.deepEqual(aggregate, expected);
};
