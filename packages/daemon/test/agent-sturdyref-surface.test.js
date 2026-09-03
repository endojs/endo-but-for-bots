// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import {
  getInterfaceGuardPayload,
  getMethodGuardPayload,
  matches,
} from '@endo/patterns';
import { makeSturdyRef } from '@endo/pass-style';
import { DirectoryInterface, GuestInterface } from '../src/interfaces.js';

/**
 * @param {object} interfaceGuard
 * @param {string} method
 */
const methodGuard = (interfaceGuard, method) => {
  const { methodGuards } = getInterfaceGuardPayload(interfaceGuard);
  return getMethodGuardPayload(methodGuards[method]);
};

test('confinement: only lookup, maybeLookup, and list admit a sturdyref', t => {
  const sturdyRef = makeSturdyRef();
  const lookup = methodGuard(DirectoryInterface, 'lookup');
  const maybeLookup = methodGuard(DirectoryInterface, 'maybeLookup');
  const list = methodGuard(DirectoryInterface, 'list');

  t.true(matches(sturdyRef, lookup.argGuards[0]), 'lookup admits it');
  t.true(matches(sturdyRef, maybeLookup.argGuards[0]), 'maybeLookup admits it');
  t.true(
    matches(harden([sturdyRef]), list.restArgGuard),
    'list admits one ref',
  );
});

test('confinement: a sturdyref cannot request an identifier or locator', t => {
  const sturdyRef = makeSturdyRef();
  for (const method of [
    'identify',
    'locate',
    'listIdentifiers',
    'listLocators',
  ]) {
    const { restArgGuard } = methodGuard(DirectoryInterface, method);
    t.false(
      matches(harden([sturdyRef]), restArgGuard),
      `${method} rejects a sturdyref before its facet runs`,
    );
  }
});

test('confinement: evaluation slots admit a sturdyref but naming slots do not', t => {
  const sturdyRef = makeSturdyRef();
  const evaluate = methodGuard(GuestInterface, 'evaluate');
  t.true(
    matches(harden([sturdyRef]), evaluate.argGuards[3]),
    'an endowment slot can receive the supplied sturdyref',
  );
  t.false(
    matches(sturdyRef, evaluate.argGuards[0]),
    'the worker naming slot cannot turn a sturdyref into naming authority',
  );
  const resultNameGuards = evaluate.optionalArgGuards;
  t.truthy(resultNameGuards, 'evaluate has a result-name guard');
  if (resultNameGuards === undefined) return;
  t.false(
    matches(sturdyRef, resultNameGuards[0]),
    'the result-name slot remains a pet name',
  );
});
