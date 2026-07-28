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

test('attenuation is structural: a facet lacks the vocabulary it lacks authority for', async t => {
  const client = makeClient();
  const { spreadsheet, writer } = makeExoSpreadsheet(client);
  // A read-only holder has nothing to call, rather than something that would
  // refuse — there is no mode to be in and no flag to check.
  for (const name of ['write', 'writeBatch', 'append', 'clear', 'writeOnly']) {
    t.is(spreadsheet[name], undefined, `Spreadsheet has no ${name}`);
  }
  const writeOnly = writer.writeOnly();
  for (const name of ['read', 'readBatch', 'readRecords', 'follow', 'title']) {
    t.is(writeOnly[name], undefined, `SpreadsheetWriteOnly has no ${name}`);
  }
  // Narrowing yields a fresh facet of the same class, never a wider one.
  const scoped = spreadsheet.sheet('Tasks').range('A1:B2');
  t.is(scoped.write, undefined);
  await t.throwsAsync(scoped.read('C1'), { message: /escapes/ });
  t.deepEqual(await scoped.read('A1:B2'), [
    ['name', 'done'],
    ['one', false],
  ]);
});

test('part() narrows the whole and composes, on every authority class', async t => {
  const client = makeClient();
  const { spreadsheet, writer } = makeExoSpreadsheet(client);
  await null;
  // A part of a whole is a narrower whole of the same authority class.
  const tab = spreadsheet.part('Tasks');
  t.deepEqual(await tab.read('A1:B2'), [
    ['name', 'done'],
    ['one', false],
  ]);
  // …and parts compose.
  const cells = tab.part('A1:B2');
  t.deepEqual(await cells.read('A1:B2'), [
    ['name', 'done'],
    ['one', false],
  ]);
  await t.throwsAsync(cells.read('C1'), { message: /escapes/ });
  // One designation may name both axes at once.
  await t.throwsAsync(spreadsheet.part('Tasks!A1:B2').read('Other!A1'), {
    message: /escapes/,
  });
  // The part axis never widens the verb axis: narrowing a reader yields a
  // reader, and narrowing a write-only facet yields a write-only facet.
  t.is(cells.write, undefined);
  t.is(writer.writeOnly().part('Tasks').read, undefined);
  // …nor the reverse: attenuating a narrowed writer keeps the narrowing.
  await t.throwsAsync(writer.part('Tasks!A1:B2').writeOnly().write('C1', []), {
    message: /escapes/,
  });
  t.is(client.calls.filter(([verb]) => verb === 'update').length, 0);
});

test('revokeWrites severs mutating authority and leaves reads intact', async t => {
  const client = makeClient();
  const { spreadsheet, writer, control } = makeExoSpreadsheet(client);
  await writer.write('Tasks!A1:B2', [['name', 'done']]);
  control.revokeWrites();
  await t.throwsAsync(writer.write('Tasks!A1:B2', [['x']]), {
    message: /revoked/,
  });
  await t.throwsAsync(writer.append('Tasks!A1:B2', [['x']]), {
    message: /revoked/,
  });
  await t.throwsAsync(writer.clear('Tasks!A1:B2'), { message: /revoked/ });
  // A facet delegated before the revocation is severed with it.
  await t.throwsAsync(writer.writeOnly().write('Tasks!A1:B2', [['x']]), {
    message: /revoked/,
  });
  t.deepEqual(await spreadsheet.read('Tasks!A1:B2'), [['name', 'done']]);
  t.deepEqual(await writer.read('Tasks!A1:B2'), [['name', 'done']]);
});

test('revoke stops metadata reads too', async t => {
  const client = makeClient();
  const { spreadsheet, control } = makeExoSpreadsheet(client);
  await null;
  t.is(await spreadsheet.title(), 'Tasks');
  control.revoke();
  await t.throwsAsync(spreadsheet.title(), { message: /revoked/ });
  await t.throwsAsync(spreadsheet.sheets(), { message: /revoked/ });
  await t.throwsAsync(spreadsheet.read('Tasks!A1:B2'), { message: /revoked/ });
});

test('the throttle bounds every request, metadata included', async t => {
  const client = makeClient();
  const { spreadsheet } = makeExoSpreadsheet(client, {
    maxRequestsPerMinute: 2,
  });
  await spreadsheet.title();
  await spreadsheet.read('Tasks!A1:B2');
  await t.throwsAsync(spreadsheet.sheets(), { message: /throttle/ });
});
