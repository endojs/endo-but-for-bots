// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import { passStyleOf } from '@endo/pass-style';
import { open, isParcel, makeParcel } from '@endo/parcel';
import { formatId } from '../src/formula-identifier.js';
import { makeFormulaParcelKit } from '../src/formula-parcel.js';

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

test('minting a Parcel for a formula does not incarnate it', t => {
  const id = idOf('1');
  const graph = makeFormulaGraph(new Map([[id, () => ({ hello: 'world' })]]));
  const { parcelForFormula, formulaIdOf } = makeFormulaParcelKit(graph);

  const ref = parcelForFormula(id);
  t.true(isParcel(ref));
  t.true(Object.isFrozen(ref));
  t.deepEqual(Reflect.ownKeys(ref), [], 'the ref reveals nothing');
  t.is(passStyleOf(ref), 'parcel');
  t.is(formulaIdOf(ref), id);
  t.deepEqual(graph.incarnations, [], 'no incarnation side effect');
});

test('opening the Parcel incarnates the formula', async t => {
  const id = idOf('2');
  const graph = makeFormulaGraph(new Map([[id, () => ({ hello: 'world' })]]));
  const { parcelForFormula } = makeFormulaParcelKit(graph);

  const ref = parcelForFormula(id);
  const pending = open(ref);
  t.deepEqual(graph.incarnations, [], 'opening happens in a later turn');
  const value = await pending;
  t.deepEqual(value, { hello: 'world' });
  t.deepEqual(graph.incarnations, [id]);

  // Opening again, or through a second ref, reuses the incarnation.
  const again = await open(parcelForFormula(id));
  t.is(again, value);
  t.deepEqual(graph.incarnations, [id]);
});

test('opening a ref to an unknown formula rejects', async t => {
  const id = idOf('3');
  const graph = makeFormulaGraph(new Map());
  const { parcelForFormula } = makeFormulaParcelKit(graph);
  const ref = parcelForFormula(id);
  await t.throwsAsync(() => open(ref), { message: /No formula/ });
});

test('minting rejects an invalid formula identifier', t => {
  const { parcelForFormula } = makeFormulaParcelKit(
    makeFormulaGraph(new Map()),
  );
  t.throws(() => parcelForFormula('not-an-id'));
});

test('formulaIdOf is closely held by the minting kit', t => {
  const id = idOf('4');
  const graph = makeFormulaGraph(new Map([[id, () => ({})]]));
  const kit = makeFormulaParcelKit(graph);
  const other = makeFormulaParcelKit(graph);
  const ref = kit.parcelForFormula(id);
  t.is(other.formulaIdOf(ref), undefined);
  t.is(kit.formulaIdOf(makeParcel(idOf('5'), () => 1)), undefined);
  t.is(kit.formulaIdOf({}), undefined);
  t.is(kit.formulaIdOf(id), undefined);
});
