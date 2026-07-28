// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E, makeLoopback } from '@endo/captp';
import { makeExoSpreadsheet } from '../index.js';

const makeClient = () => {
  const calls = [];
  const values = new Map([
    [
      'Tasks!A1:B2',
      [
        ['name', 'done'],
        ['one', false],
      ],
    ],
  ]);
  return {
    calls,
    values: {
      get: async range => {
        calls.push(['get', range]);
        return { values: values.get(range) || [] };
      },
      update: async (range, rows) => {
        calls.push(['update', range]);
        values.set(range, rows);
        return { updatedRange: range, updatedCells: rows.flat().length };
      },
      append: async (range, rows) => {
        calls.push(['append', range]);
        return { updates: { updatedRange: range, updatedRows: rows.length } };
      },
      clear: async range => {
        calls.push(['clear', range]);
      },
    },
    spreadsheets: {
      get: async () => ({ properties: { title: 'Tasks' }, sheets: [] }),
    },
  };
};
test('facets attenuate permissions and range scope over loopback CapTP', async t => {
  const client = makeClient();
  const facets = makeExoSpreadsheet(client, {
    pollIntervalMs: 0,
  });
  const { makeFar, isOnlyFar } = makeLoopback('guest');
  const { spreadsheet, writer, control } = await makeFar(facets);
  t.true(isOnlyFar(spreadsheet));
  t.deepEqual(await E(E(spreadsheet).sheet('Tasks')).read('A1:B2'), [
    ['name', 'done'],
    ['one', false],
  ]);
  t.deepEqual(await E(spreadsheet).readRecords('Tasks!A1:B2'), [
    { name: 'one', done: false },
  ]);
  const reader = await E(writer).readOnly();
  const appender = await E(writer).appendOnly();
  t.is(reader.write, undefined);
  t.is(appender.read, undefined);
  await E(E(writer).range('Tasks!A1:B2')).write('A1', [['x']]);
  await t.throwsAsync(E(E(writer).range('Tasks!A1:B2')).write('C1', [['x']]), {
    message: /escapes/,
  });
  await E(control).setAllowedSheets(['Tasks']);
  await t.throwsAsync(E(writer).write('Other!A1', [['x']]), {
    message: /allowed/,
  });
});
