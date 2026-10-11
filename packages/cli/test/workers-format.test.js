import test from 'ava';
import { formatWorkers } from '../src/commands/workers-format.js';

test('text: empty listing renders as empty string', t => {
  t.is(formatWorkers([]), '');
  t.is(formatWorkers([], { json: false }), '');
});

test('json: empty listing renders as []', t => {
  t.is(formatWorkers([], { json: true }), '[]');
});

test('text: single worker with no tenants uses singular-aware count', t => {
  t.is(formatWorkers([{ name: 'w0', tenants: [] }]), 'w0 (0 tenants)');
});

test('text: worker with one tenant is singular', t => {
  t.is(
    formatWorkers([{ name: 'w0', tenants: [{ name: 'agent', type: 'eval' }] }]),
    ['w0 (1 tenant)', '  agent [eval]'].join('\n'),
  );
});

test('text: multiple workers and tenants, indented under each worker', t => {
  const listing = [
    {
      name: 'w0',
      tenants: [
        { name: 'agent', type: 'eval' },
        { name: 'helper', type: 'guest' },
      ],
    },
    { name: 'w1', tenants: [] },
  ];
  t.is(
    formatWorkers(listing),
    [
      'w0 (2 tenants)',
      '  agent [eval]',
      '  helper [guest]',
      'w1 (0 tenants)',
    ].join('\n'),
  );
});

test('json: pretty-prints the listing verbatim', t => {
  const listing = [{ name: 'w0', tenants: [{ name: 'agent', type: 'eval' }] }];
  t.is(
    formatWorkers(listing, { json: true }),
    JSON.stringify(listing, null, 2),
  );
});
