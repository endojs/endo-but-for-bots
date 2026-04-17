import test from '@endo/ses-ava/prepare-endo.js';

import {
  addressesFromLocator,
  assertValidLocator,
  formatLocator,
  formatLocatorForSharing,
  formatLocatorV2,
  idFromLocator,
  parseLocator,
  externalizeId,
  internalizeLocator,
} from '../src/locator.js';
import { formatId, parseId } from '../src/formula-identifier.js';

const validNode =
  'd5c98890be3d17ad375517464ec494068267de60bd4b3143ef0214cc895746f2';
const validId =
  '5cf3d8b4d6e03fb51d71fbbb6fa6982edbff673cd193707c902b70a26b7b4680';
const validType = 'eval';

const makeLocator = (components = {}) => {
  const {
    protocol = 'endo://',
    host = validNode,
    param1 = `id=${validId}`,
    param2 = `type=${validType}`,
  } = components;
  return `${protocol}${host}/?${param1}&${param2}`;
};

test('assertValidLocator - valid', t => {
  t.notThrows(() => assertValidLocator(makeLocator()));

  // Reverse search param order
  t.notThrows(() =>
    assertValidLocator(
      makeLocator({
        param1: `type=${validType}`,
        param2: `id=${validId}`,
      }),
    ),
  );
});

test('assertValidLocator - invalid', t => {
  [
    ['foobar', /Invalid URL.$/u],
    ['', /Invalid URL.$/u],
    [null, /Invalid URL.$/u],
    [undefined, /Invalid URL.$/u],
    [{}, /Invalid URL.$/u],
    [makeLocator({ protocol: 'foobar://' }), /Invalid protocol.$/u],
    [makeLocator({ host: 'foobar' }), /Invalid node identifier.$/u],
    [makeLocator({ param1: 'foo=bar' }), /Missing formula number/],
    [makeLocator({ param2: 'foo=bar' }), /Invalid search params.$/u],
    [`${makeLocator()}&foo=bar`, /Invalid search params.$/u],
    [makeLocator({ param1: 'id=foobar' }), /Invalid id.$/u],
    [makeLocator({ param2: 'type=foobar' }), /Invalid type.$/u],
  ].forEach(([locator, reason]) => {
    t.throws(() => assertValidLocator(locator), { message: reason });
  });
});

test('parseLocator', t => {
  t.deepEqual(parseLocator(makeLocator()), {
    number: validId,
    node: validNode,
    formulaType: validType,
    hints: [],
  });
});

test('formatLocator', t => {
  t.is(
    formatLocator(formatId({ number: validId, node: validNode }), validType),
    makeLocator(),
  );
});

test('idFromLocator', t => {
  t.is(
    idFromLocator(makeLocator()),
    formatId({ number: validId, node: validNode }),
  );
});

test('parseLocator - tolerates at= connection hints', t => {
  const locator = `${makeLocator()}&at=libp2p%2Bcaptp0%3A%2F%2Fpeer1&at=libp2p%2Bcaptp0%3A%2F%2Fpeer2`;
  const parsed = parseLocator(locator);
  t.is(parsed.number, validId);
  t.is(parsed.node, validNode);
  t.is(parsed.formulaType, validType);
  t.deepEqual(parsed.hints, [
    'libp2p+captp0://peer1',
    'libp2p+captp0://peer2',
  ]);
});

test('formatLocatorForSharing', t => {
  const id = formatId({ number: validId, node: validNode });
  const addresses = ['libp2p+captp0:///peer1', 'tcp+captp0://127.0.0.1:8940'];
  const locator = formatLocatorForSharing(id, validType, addresses);
  t.true(locator.startsWith('endo://'));
  const parsed = parseLocator(locator);
  t.is(parsed.number, validId);
  t.is(parsed.node, validNode);
  t.is(parsed.formulaType, validType);
  const extractedAddresses = addressesFromLocator(locator);
  t.deepEqual(extractedAddresses, addresses);
});

test('formatLocatorForSharing - no addresses', t => {
  const id = formatId({ number: validId, node: validNode });
  const locator = formatLocatorForSharing(id, validType, []);
  t.is(locator, formatLocator(id, validType));
  t.deepEqual(addressesFromLocator(locator), []);
});

test('addressesFromLocator - plain locator returns empty', t => {
  t.deepEqual(addressesFromLocator(makeLocator()), []);
});

// --- externalizeId, internalizeLocator ---

test('externalizeId formats locator from id', t => {
  const formulaNumber = validId;
  const id = formatId({ number: formulaNumber, node: validNode });
  const locator = externalizeId(id, validType, validNode);
  const parsed = parseLocator(locator);
  t.is(parsed.node, validNode);
  t.is(parsed.number, formulaNumber);
  t.is(parsed.formulaType, validType);
});

test('externalizeId preserves remote node', t => {
  const formulaNumber = validId;
  const remoteNode =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const remoteId = formatId({ number: formulaNumber, node: remoteNode });
  const locator = externalizeId(remoteId, validType, validNode);
  const parsed = parseLocator(locator);
  t.is(parsed.node, remoteNode, 'remote node should be preserved');
});

test('internalizeLocator preserves node', t => {
  const formulaNumber = validId;
  const locator = formatLocator(
    formatId({ number: formulaNumber, node: validNode }),
    validType,
  );
  const result = internalizeLocator(locator);
  const { number, node } = parseId(result.id);
  t.is(node, validNode, 'node should be preserved');
  t.is(number, formulaNumber);
  t.is(result.formulaType, validType);
});

test('internalizeLocator preserves remote node', t => {
  const formulaNumber = validId;
  const remoteNode =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const locator = formatLocator(
    formatId({ number: formulaNumber, node: remoteNode }),
    validType,
  );
  const result = internalizeLocator(locator);
  const { node } = parseId(result.id);
  t.is(node, remoteNode, 'remote node should be preserved');
});

test('externalizeId / internalizeLocator round-trip', t => {
  const formulaNumber = validId;
  const id = formatId({ number: formulaNumber, node: validNode });
  const locator = externalizeId(id, validType, validNode);
  const result = internalizeLocator(locator);
  t.is(result.id, id, 'round-trip should preserve id');
  t.is(result.formulaType, validType);
});

test('externalizeId / internalizeLocator round-trip preserves remote node', t => {
  const formulaNumber = validId;
  const remoteNode =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const remoteId = formatId({ number: formulaNumber, node: remoteNode });
  const locator = externalizeId(remoteId, validType, validNode);
  const result = internalizeLocator(locator);
  t.is(result.id, remoteId, 'remote id should be preserved');
});

test('internalizeLocator extracts connection hints', t => {
  const id = formatId({ number: validId, node: validNode });
  const addresses = ['tcp://127.0.0.1:8940', 'ws://example.com'];
  const locator = formatLocatorForSharing(id, validType, addresses);
  const result = internalizeLocator(locator);
  t.deepEqual(result.addresses, addresses);
});

// --- New-style locator format (path-based formula number) ---

test('parseLocator - new format with formula number in path', t => {
  const newLocator = `endo://${validNode}/${validId}?type=${validType}`;
  const parsed = parseLocator(newLocator);
  t.is(parsed.number, validId);
  t.is(parsed.node, validNode);
  t.is(parsed.formulaType, validType);
  t.deepEqual(parsed.hints, []);
});

test('parseLocator - new format with connection hints', t => {
  const newLocator = `endo://${validNode}/${validId}?type=${validType}&at=ws%3A%2F%2Fexample.com`;
  const parsed = parseLocator(newLocator);
  t.is(parsed.number, validId);
  t.is(parsed.formulaType, validType);
  t.deepEqual(parsed.hints, ['ws://example.com']);
});

test('parseLocator - new format rejects invalid search params', t => {
  const badLocator = `endo://${validNode}/${validId}?type=${validType}&bad=param`;
  t.throws(() => parseLocator(badLocator), {
    message: /Invalid search params/,
  });
});

test('parseLocator - rejects locator with no formula number', t => {
  const badLocator = `endo://${validNode}/?type=${validType}`;
  t.throws(() => parseLocator(badLocator), {
    message: /Missing formula number/,
  });
});

test('parseLocator - old and new formats produce identical results', t => {
  const oldLocator = `endo://${validNode}/?id=${validId}&type=${validType}`;
  const newLocator = `endo://${validNode}/${validId}?type=${validType}`;
  const oldResult = parseLocator(oldLocator);
  const newResult = parseLocator(newLocator);
  t.is(oldResult.number, newResult.number);
  t.is(oldResult.node, newResult.node);
  t.is(oldResult.formulaType, newResult.formulaType);
  t.deepEqual(oldResult.hints, newResult.hints);
});

// --- formatLocatorV2 ---

test('formatLocatorV2 produces path-based format', t => {
  const fmtId = formatId({ number: validId, node: validNode });
  const locator = formatLocatorV2(fmtId, validType);
  // Should contain the formula number in the path, not in ?id=
  t.true(locator.includes(`/${validId}`));
  t.false(locator.includes('id='));
  t.true(locator.includes(`type=${validType}`));
});

test('formatLocatorV2 round-trips through parseLocator', t => {
  const fmtId = formatId({ number: validId, node: validNode });
  const locator = formatLocatorV2(fmtId, validType);
  const parsed = parseLocator(locator);
  t.is(parsed.number, validId);
  t.is(parsed.node, validNode);
  t.is(parsed.formulaType, validType);
  t.deepEqual(parsed.hints, []);
});

test('formatLocatorV2 and formatLocator parse equivalently', t => {
  const fmtId = formatId({ number: validId, node: validNode });
  const oldLocator = formatLocator(fmtId, validType);
  const newLocator = formatLocatorV2(fmtId, validType);
  const oldParsed = parseLocator(oldLocator);
  const newParsed = parseLocator(newLocator);
  t.is(oldParsed.number, newParsed.number);
  t.is(oldParsed.node, newParsed.node);
  t.is(oldParsed.formulaType, newParsed.formulaType);
});
