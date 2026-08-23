// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { fc } from '@fast-check/ava';
import { E, makeLoopback } from '@endo/captp';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import harden from '@endo/harden';
import { makeExoSpreadsheet } from '../index.js';
import { contains, parseA1, sheetPrefix } from '../src/a1.js';
import { cellRevision, makeReader } from '../src/facets.js';
import { makePolicy, makeReadPowers, narrowScope } from '../src/powers.js';

/** @param {number} number */
const columnLetters = number => {
  let current = number;
  let letters = '';
  while (current > 0) {
    current -= 1;
    letters = String.fromCharCode(65 + (current % 26)) + letters;
    current = Math.floor(current / 26);
  }
  return letters;
};

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
      get: async () => ({
        properties: { title: 'Tasks' },
        sheets: [
          {
            properties: {
              sheetId: 1,
              title: 'Tasks',
              index: 0,
              gridProperties: { rowCount: 100, columnCount: 10 },
            },
          },
          {
            properties: {
              sheetId: 2,
              title: 'Secrets',
              index: 1,
              gridProperties: { rowCount: 50, columnCount: 5 },
            },
          },
        ],
      }),
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
  await t.throwsAsync(
    E(E(writer).range('Tasks!A1:B2')).write('Other!A1', [['x']]),
    { message: /sheet scope/ },
  );
  await t.throwsAsync(E(E(writer).range('Tasks!A1:B2')).write('C1', [['x']]), {
    message: /escapes/,
  });
  await t.throwsAsync(E(E(writer).range('Tasks!A1:B2')).write('A:A', [['x']]), {
    message: /confined/,
  });
  await E(control).setAllowedSheets(['Tasks']);
  await t.throwsAsync(E(writer).write('Other!A1', [['x']]), {
    message: /allowed/,
  });
  await E(control).setAllowedRanges(['Tasks!A1:B2']);
  await E(writer).write('Tasks!A1', [['inside']]);
  await t.throwsAsync(E(writer).write('Tasks!C1', [['outside']]), {
    message: /allowed/,
  });
  const remoteFollower = await E(spreadsheet).follow('Tasks!A1:B2');
  const remoteIterator = iterateReader(remoteFollower);
  const remoteFirst = await remoteIterator.next();
  t.false(remoteFirst.done);
  const remoteChange = /** @type {{ values: any[][] }} */ (remoteFirst.value);
  t.deepEqual(remoteChange.values, [
    ['name', 'done'],
    ['one', false],
  ]);
  await remoteIterator.return();
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
  // ...and parts compose.
  const cells = tab.part('A1:B2');
  t.deepEqual(await cells.read('A1:B2'), [
    ['name', 'done'],
    ['one', false],
  ]);
  await t.throwsAsync(cells.read('C1'), { message: /escapes/ });
  t.throws(() => tab.sheet('Secrets'), { message: /sheet scope/ });
  t.throws(() => cells.range('A1:Z99'), { message: /range scope/ });
  t.throws(() => cells.part('Secrets!A1'), { message: /sheet scope/ });
  // One designation may name both axes at once.
  await t.throwsAsync(spreadsheet.part('Tasks!A1:B2').read('Other!A1'), {
    message: /escapes/,
  });
  // The part axis never widens the verb axis: narrowing a reader yields a
  // reader, and narrowing a write-only facet yields a write-only facet.
  t.is(cells.write, undefined);
  t.is(writer.writeOnly().part('Tasks').read, undefined);
  // ...nor the reverse: attenuating a narrowed writer keeps the narrowing.
  await t.throwsAsync(writer.part('Tasks!A1:B2').writeOnly().write('C1', []), {
    message: /escapes/,
  });
  const boundedWriter = writer.part('Tasks!A1:B2');
  await t.throwsAsync(
    boundedWriter.write('A1', [
      [1, 2, 3],
      [4, 5, 6],
    ]),
    { message: /payload escapes/ },
  );
  await t.throwsAsync(
    boundedWriter.appendOnly().append('A1:B2', [[1, 2, 3]]),
    { message: /not available/ },
  );
  await t.throwsAsync(
    boundedWriter.appendOnly().append('A1:B2', [[1, 2]]),
    { message: /not available/ },
  );
  await t.throwsAsync(
    writer.appendOnly().append('Tasks!A1:B2', [[1, 2, 3]]),
    { message: /payload escapes/ },
  );
  await writer.appendOnly().append('Tasks!A1:B2', [[1, 2]]);
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

test('sheet metadata obeys facet and host scope', async t => {
  const client = makeClient();
  const { spreadsheet, control } = makeExoSpreadsheet(client);
  await null;
  const scopedSheets = await spreadsheet.sheet('Tasks').sheets();
  t.deepEqual(
    scopedSheets.map(({ title }) => title),
    ['Tasks'],
  );
  control.setAllowedSheets(['Secrets']);
  const allowedSheets = await spreadsheet.sheets();
  t.deepEqual(
    allowedSheets.map(({ title }) => title),
    ['Secrets'],
  );
});

test('readRecords rejects duplicate headers instead of dropping a column', async t => {
  const client = makeClient();
  client.values.update('Tasks!A1:B2', [
    ['name', 'name'],
    ['first', 'second'],
  ]);
  const { spreadsheet } = makeExoSpreadsheet(client);
  await t.throwsAsync(spreadsheet.readRecords('Tasks!A1:B2'), {
    message: /headers must be unique/,
  });
});

test('A1 rectangles normalize corners and reject unsafe coordinates', t => {
  t.deepEqual(parseA1('Tasks!Z9:A1'), parseA1('Tasks!A1:Z9'));
  t.is(parseA1('A0'), undefined);
  t.is(parseA1(`A${Number.MAX_SAFE_INTEGER + 1}`), undefined);
  t.is(parseA1("''!A1"), undefined);
  t.is(parseA1('A!B!A1'), undefined);
  const quoted = parseA1(`${sheetPrefix("It's work!")}!A1`);
  t.truthy(quoted);
  t.is(quoted && quoted.sheet, "It's work!");
});

test('quoted sheet names round-trip through A1 notation', t => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), sheet => {
      const parsed = parseA1(`${sheetPrefix(sheet)}!A1`);
      return parsed !== undefined && parsed.sheet === sheet;
    }),
  );
  t.pass();
});

test('rectangle containment is reflexive and transitive', t => {
  const rectangles = [];
  for (let left = 1; left <= 3; left += 1) {
    for (let right = left; right <= 3; right += 1) {
      for (let top = 1; top <= 3; top += 1) {
        for (let bottom = top; bottom <= 3; bottom += 1) {
          rectangles.push({ sheet: undefined, left, right, top, bottom });
        }
      }
    }
  }
  for (const rectangle of rectangles) t.true(contains(rectangle, rectangle));
  for (const outer of rectangles) {
    for (const middle of rectangles) {
      for (const inner of rectangles) {
        if (contains(outer, middle) && contains(middle, inner)) {
          t.true(contains(outer, inner));
        }
      }
    }
  }
});

test('successful scope narrowing never widens its rectangle', t => {
  const rectangle = fc
    .tuple(
      fc.integer({ min: 1, max: 700 }),
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 1, max: 700 }),
      fc.integer({ min: 1, max: 20 }),
    )
    .map(([columnA, rowA, columnB, rowB]) => ({
      sheet: undefined,
      left: Math.min(columnA, columnB),
      top: Math.min(rowA, rowB),
      right: Math.max(columnA, columnB),
      bottom: Math.max(rowA, rowB),
    }));
  /** @param {{ left: number, top: number, right: number, bottom: number }} range */
  const notation = range =>
    `${columnLetters(range.left)}${range.top}:${columnLetters(range.right)}${range.bottom}`;
  fc.assert(
    fc.property(rectangle, rectangle, (outer, patch) => {
      try {
        const narrowed = narrowScope(
          { sheet: 'Tasks', range: `Tasks!${notation(outer)}` },
          { range: notation(patch) },
        );
        const result = narrowed.range ? parseA1(narrowed.range) : undefined;
        return result !== undefined && contains(outer, result);
      } catch {
        return !contains(outer, patch);
      }
    }),
  );
  t.pass();
});

test('confine never resolves a target outside its scope', t => {
  const rectangle = fc
    .tuple(
      fc.integer({ min: 1, max: 700 }),
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 1, max: 700 }),
      fc.integer({ min: 1, max: 20 }),
    )
    .map(([columnA, rowA, columnB, rowB]) => ({
      sheet: undefined,
      left: Math.min(columnA, columnB),
      top: Math.min(rowA, rowB),
      right: Math.max(columnA, columnB),
      bottom: Math.max(rowA, rowB),
    }));
  /** @param {{ left: number, top: number, right: number, bottom: number }} range */
  const notation = range =>
    `${columnLetters(range.left)}${range.top}:${columnLetters(range.right)}${range.bottom}`;
  const policy = makePolicy({ now: () => 0 });
  fc.assert(
    fc.property(rectangle, rectangle, (scopeRange, targetRange) => {
      try {
        const full = policy.confine(notation(targetRange), {
          sheet: 'Tasks',
          range: `Tasks!${notation(scopeRange)}`,
        });
        const result = parseA1(full);
        return result !== undefined && contains(scopeRange, result);
      } catch {
        return true;
      }
    }),
  );
  t.pass();
});

test('follower revisions preserve numeric sentinel distinctions', t => {
  t.not(cellRevision([[0]]), cellRevision([[-0]]));
  t.not(cellRevision([[null]]), cellRevision([[NaN]]));
  t.not(cellRevision([[NaN]]), cellRevision([[Infinity]]));
  t.not(cellRevision([[Infinity]]), cellRevision([[-Infinity]]));
});

test('range narrowing accepts only bounded rectangles', async t => {
  const { spreadsheet } = makeExoSpreadsheet(makeClient());
  await null;
  t.throws(() => spreadsheet.sheet(''), { message: /non-empty/ });
  t.throws(() => spreadsheet.range('A:A'), { message: /bounded/ });
  t.throws(() => spreadsheet.range('named-range'), { message: /bounded/ });
  t.throws(() => spreadsheet.range('A1:B2'), { message: /requires a sheet/ });
  await t.throwsAsync(spreadsheet.sheet('Tasks').read('Tasks'), {
    message: /bounded A1 range/,
  });
});

test('follow() polls on a granted timer, never an ambient one', async t => {
  const client = makeClient();
  const waits = [];
  const { spreadsheet, control } = makeExoSpreadsheet(client, {
    pollIntervalMs: 5000,
    // The whole point: the modules under the boundary hold no timer of their
    // own, so every wait the follower takes is visible here.  Editing the
    // sheet from inside the first wait is what makes the second poll differ.
    setTimeout: (callback, ms) => {
      waits.push(ms);
      if (waits.length === 1) {
        client.values.update('Tasks!A1:B2', [
          ['name', 'done'],
          ['two', true],
        ]);
      }
      callback();
      return undefined;
    },
  });
  const follower = iterateReader(spreadsheet.follow('Tasks!A1:B2'));
  const first = await follower.next();
  t.false(first.done);
  const firstChange = /** @type {{ values: any[][] }} */ (first.value);
  t.deepEqual(firstChange.values, [
    ['name', 'done'],
    ['one', false],
  ]);
  // The first yield is the initial contents, reached without waiting.
  t.deepEqual(waits, []);
  // The interval remains the host's to change mid-follow, and the wait takes
  // the new one — the granted timer carries no interval of its own.
  control.setPollIntervalMs(7000);
  const second = await follower.next();
  t.false(second.done);
  const secondChange = /** @type {{ values: any[][] }} */ (second.value);
  t.deepEqual(secondChange.values, [
    ['name', 'done'],
    ['two', true],
  ]);
  t.deepEqual(waits, [7000]);
  t.deepEqual(await follower.return(), { done: true, value: undefined });
});

test('a zero poll interval is preserved', async t => {
  const client = makeClient();
  const waits = [];
  const { spreadsheet } = makeExoSpreadsheet(client, {
    pollIntervalMs: 0,
    setTimeout: (callback, ms) => {
      waits.push(ms);
      client.values.update('Tasks!A1:B2', [['changed']]);
      callback();
    },
  });
  const follower = iterateReader(spreadsheet.follow('Tasks!A1:B2'));
  await follower.next();
  await follower.next();
  t.deepEqual(waits, [0]);
  await follower.return();
});

test('constructor limits reject invalid zero values', t => {
  t.throws(() => makeExoSpreadsheet(makeClient(), { maxCellsPerRead: 0 }), {
    message: /max cells/,
  });
  t.throws(() => makeExoSpreadsheet(makeClient(), { maxCellsPerWrite: 0 }), {
    message: /max write cells/,
  });
  t.throws(
    () => makeExoSpreadsheet(makeClient(), { maxRequestsPerMinute: 0 }),
    { message: /request limit/ },
  );
});

test('mutation payloads obey the host cell cap', async t => {
  const client = makeClient();
  const { writer } = makeExoSpreadsheet(client, { maxCellsPerWrite: 2 });
  await t.throwsAsync(writer.write('Tasks!A1:C1', [[1, 2, 3]]), {
    message: /maximum cell count/,
  });
  await t.throwsAsync(writer.append('Tasks!A1:C1', [[1, 2, 3]]), {
    message: /maximum cell count/,
  });
  t.deepEqual(client.calls, []);
});

test('the request clock must stay finite and monotonic', async t => {
  let instant = 1;
  const { spreadsheet } = makeExoSpreadsheet(makeClient(), {
    now: () => instant,
  });
  instant = NaN;
  await t.throwsAsync(spreadsheet.read('Tasks!A1'), {
    message: /finite and monotonic/,
  });
  t.throws(() => makeExoSpreadsheet(makeClient(), { now: () => Infinity }), {
    message: /clock must be finite/,
  });
  instant = 1;
  const second = makeExoSpreadsheet(makeClient(), { now: () => instant });
  instant = 0;
  await t.throwsAsync(second.spreadsheet.read('Tasks!A1'), {
    message: /finite and monotonic/,
  });
});

test('column letters round-trip across the Z to AA boundary', t => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 700 }), number => {
      const parsed = parseA1(`${columnLetters(number)}1`);
      return parsed !== undefined && parsed.left === number;
    }),
  );
  t.pass();
});

test('bounded reads are rejected before fetching when they exceed the cap', async t => {
  const client = makeClient();
  const { spreadsheet } = makeExoSpreadsheet(client, { maxCellsPerRead: 4 });
  await t.throwsAsync(spreadsheet.read('Tasks!A1:C2'), {
    message: /maximum cell count/,
  });
  await t.throwsAsync(spreadsheet.read('Tasks'), {
    message: /bounded A1 range/,
  });
  t.deepEqual(client.calls, []);
});

test('follow resolves its designation without spending a request token', async t => {
  const { spreadsheet } = makeExoSpreadsheet(makeClient(), {
    maxRequestsPerMinute: 1,
  });
  const follower = iterateReader(spreadsheet.follow('Tasks!A1:B2'));
  const first = await follower.next();
  t.false(first.done);
  await follower.return();
});

test('follow rechecks revocation after it starts', async t => {
  const { spreadsheet, control } = makeExoSpreadsheet(makeClient());
  const follower = iterateReader(spreadsheet.follow('Tasks!A1:B2'));
  await follower.next();
  control.revoke();
  await t.throwsAsync(follower.next(), { message: /revoked/ });
});

test('a host that grants no timer grants no polling', async t => {
  await null;
  const client = makeClient();
  const { spreadsheet } = makeExoSpreadsheet(client, {
    pollIntervalMs: 0,
    setTimeout: null,
  });
  // Reads still work; only the authority to wait is missing, and the follower
  // says so rather than reaching for a global.
  t.deepEqual(await spreadsheet.read('Tasks!A1:B2'), [
    ['name', 'done'],
    ['one', false],
  ]);
  const follower = iterateReader(spreadsheet.follow('Tasks!A1:B2'));
  await follower.next();
  await t.throwsAsync(follower.next(), { message: /no timer/ });
});

test('a facet builds over powers alone, with no client in reach', async t => {
  await null;
  // No client and no `makeExoSpreadsheet`: just two read operations, a stub
  // forwarder, and the caps.  That a working reader composes from this much is
  // the layer boundary stated as a test — `facets.js` uses nothing it was not
  // handed, so a reader's authority is exactly the argument list below.
  const admitted = [];
  const reader = makeReader(
    makeReadPowers({
      getValues: async range => ({ values: [[range]] }),
      getSpreadsheet: async () => ({ properties: { title: 'Standalone' } }),
      access: harden({
        enter: () => {},
        /**
         * @param {string} selector
         * @param {{ sheet?: string }} scope
         */
        admit: (selector, scope) => {
          admitted.push([selector, scope.sheet]);
          return scope.sheet ? `${scope.sheet}!${selector}` : selector;
        },
        designate: (selector, scope) =>
          scope.sheet ? `${scope.sheet}!${selector}` : selector,
        revoke: () => {},
      }),
      limits: harden({
        boundRange: selector => selector,
        /** @param {any[][]} values */
        boundCells: values => harden(values.map(row => harden([...row]))),
        /** @param {any[][]} values */
        boundWriteCells: values => harden(values),
        pollIntervalMs: () => 0,
        boundSheets: sheets => harden(sheets),
      }),
      delay: async () => {},
    }),
  );
  t.is(await reader.title(), 'Standalone');
  t.deepEqual(await reader.part('Tasks').read('A1'), [['Tasks!A1']]);
  // Every read went out through the forwarder, carrying the facet's scope.
  t.deepEqual(admitted, [['A1', 'Tasks']]);
  // ...and there is still no write vocabulary to find, because none was passed.
  t.is(reader.write, undefined);
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

test('a rejected request does not spend the shared request budget', async t => {
  const client = makeClient();
  const { spreadsheet } = makeExoSpreadsheet(client, {
    maxRequestsPerMinute: 1,
  });
  await t.throwsAsync(spreadsheet.sheet('Tasks').read('Other!A1'), {
    message: /sheet scope/,
  });
  t.deepEqual(await spreadsheet.read('Tasks!A1:B2'), [
    ['name', 'done'],
    ['one', false],
  ]);
});

test('cell guards reject capabilities and unsupported scalar types', async t => {
  const { writer } = makeExoSpreadsheet(makeClient());
  await t.throwsAsync(writer.write('Tasks!A1', [[1n]]), {
    message: /Must match one of/,
  });
});
