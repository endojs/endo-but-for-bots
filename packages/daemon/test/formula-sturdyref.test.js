// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import { enliven, isSturdyRef, makeSturdyRef } from '@endo/sturdyref';
import { formatId } from '../src/formula-identifier.js';
import { makeFormulaSturdyRefKit } from '../src/formula-sturdyref.js';

const node = 'a'.repeat(64);
const idOf = n => formatId({ number: n.repeat(64), node });

// A stand-in for the daemon's formula graph: `provide` incarnates a formula
// on first request and records that it did.
const makeFormulaGraph = formulas => {
  const incarnations = [];
  const live = new Map();
  const provide = id => {
    if (!live.has(id)) {
      const make = formulas.get(id);
      if (make === undefined) {
        throw Error(`No formula for ${id}`);
      }
      incarnations.push(id);
      live.set(id, make());
    }
    return live.get(id);
  };
  return { provide, incarnations };
};

test('minting a SturdyRef for a formula does not incarnate it', t => {
  const id = idOf('1');
  const graph = makeFormulaGraph(new Map([[id, () => ({ hello: 'world' })]]));
  const { sturdyRefForFormula, formulaIdOf } = makeFormulaSturdyRefKit(graph);

  const ref = sturdyRefForFormula(id);
  t.true(isSturdyRef(ref));
  t.true(Object.isFrozen(ref));
  t.deepEqual(Object.keys(ref), [], 'the ref reveals nothing');
  t.is(formulaIdOf(ref), id);
  t.deepEqual(graph.incarnations, [], 'no incarnation side effect');
});

test('enlivening the SturdyRef incarnates the formula', async t => {
  const id = idOf('2');
  const graph = makeFormulaGraph(new Map([[id, () => ({ hello: 'world' })]]));
  const { sturdyRefForFormula } = makeFormulaSturdyRefKit(graph);

  const ref = sturdyRefForFormula(id);
  const pending = enliven(ref);
  t.deepEqual(graph.incarnations, [], 'enlivening happens in a later turn');
  const value = await pending;
  t.deepEqual(value, { hello: 'world' });
  t.deepEqual(graph.incarnations, [id]);

  // Enlivening again, or through a second ref, reuses the incarnation.
  const again = await enliven(sturdyRefForFormula(id));
  t.is(again, value);
  t.deepEqual(graph.incarnations, [id]);
});

test('enlivening a ref to an unknown formula rejects', async t => {
  const id = idOf('3');
  const graph = makeFormulaGraph(new Map());
  const { sturdyRefForFormula } = makeFormulaSturdyRefKit(graph);
  const ref = sturdyRefForFormula(id);
  await t.throwsAsync(() => enliven(ref), { message: /No formula/ });
});

test('minting rejects an invalid formula identifier', t => {
  const { sturdyRefForFormula } = makeFormulaSturdyRefKit(
    makeFormulaGraph(new Map()),
  );
  t.throws(() => sturdyRefForFormula('not-an-id'));
});

test('formulaIdOf is closely held by the minting kit', t => {
  const id = idOf('4');
  const graph = makeFormulaGraph(new Map([[id, () => ({})]]));
  const kit = makeFormulaSturdyRefKit(graph);
  const other = makeFormulaSturdyRefKit(graph);
  const ref = kit.sturdyRefForFormula(id);
  t.is(other.formulaIdOf(ref), undefined);
  t.is(kit.formulaIdOf(makeSturdyRef({ enliven: () => 1 })), undefined);
  t.is(kit.formulaIdOf({}), undefined);
  t.is(kit.formulaIdOf(id), undefined);
});
