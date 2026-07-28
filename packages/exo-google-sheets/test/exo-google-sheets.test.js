// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
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
test('facets attenuate permissions and range scope', async t => {
  const client = makeClient();
  const { spreadsheet, writer, control } = makeExoSpreadsheet(client, {
    pollIntervalMs: 0,
  });
  t.deepEqual(await spreadsheet.sheet('Tasks').read('A1:B2'), [
    ['name', 'done'],
    ['one', false],
  ]);
  t.deepEqual(await spreadsheet.readRecords('Tasks!A1:B2'), [
    { name: 'one', done: false },
  ]);
  t.is(writer.readOnly().write, undefined);
  t.is(writer.appendOnly().read, undefined);
  await writer.range('Tasks!A1:B2').write('A1', [['x']]);
  await t.throwsAsync(writer.range('Tasks!A1:B2').write('C1', [['x']]), {
    message: /escapes/,
  });
  control.setAllowedSheets(['Tasks']);
  await t.throwsAsync(writer.write('Other!A1', [['x']]), {
    message: /allowed/,
  });
});
