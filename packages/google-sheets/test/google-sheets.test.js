import test from '@endo/ses-ava/prepare-endo.js';

import {
  encodeA1Range,
  GoogleSheetsError,
  iso8601ToSerial,
  makeSheetsClient,
  serialToISO8601,
} from '../index.js';

/**
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} headers
 */
const response = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => payload,
});

const makeFetch = replies => {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return replies.shift();
    },
  };
};

test('encodes A1 ranges as a single path segment', t => {
  t.is(
    encodeA1Range("O'Brien's Sheet!A1:C10"),
    'O%27Brien%27s%20Sheet%21A1%3AC10',
  );
  t.is(encodeA1Range('Sheet 1!A:A'), 'Sheet%201%21A%3AA');
  t.throws(() => encodeA1Range(''), { instanceOf: TypeError });
});

test('converts Sheets serial dates without guessing cell types', t => {
  t.is(serialToISO8601(25_569), '1970-01-01T00:00:00.000Z');
  t.is(iso8601ToSerial('1970-01-01T00:00:00.000Z'), 25_569);
});

test('values methods construct REST requests and parse responses', async t => {
  await null;
  const fixture = makeFetch([
    response(200, { values: [[1, 2]] }),
    response(200, { valueRanges: [] }),
    response(200, { updatedCells: 2 }),
    response(200, { responses: [{ updatedCells: 2 }] }),
    response(200, { updates: { updatedRows: 1 } }),
    response(200, { clearedRange: 'Tasks!A1:C10' }),
    response(200, { properties: { title: 'Tasks' } }),
  ]);
  const client = makeSheetsClient(fixture.fetch, { spreadsheetId: 'sheet id' });
  t.deepEqual(await client.values.get('Tasks!A1:B2'), { values: [[1, 2]] });
  t.deepEqual(await client.values.batchGet(['Tasks!A1', 'Tasks!B1']), {
    valueRanges: [],
  });
  await client.values.update('Tasks!A1', [[1, 2]]);
  t.deepEqual(
    await client.values.batchUpdate([
      { range: 'Tasks!A2:B2', values: [[3, 4]] },
    ]),
    { responses: [{ updatedCells: 2 }] },
  );
  await client.values.append('Tasks!A1', [[3, 4]]);
  await client.values.clear('Tasks!A1:C10');
  await client.spreadsheets.get({ includeGridData: false });
  t.regex(
    fixture.calls[0].url,
    /sheet%20id\/values\/Tasks%21A1%3AB2\?valueRenderOption=UNFORMATTED_VALUE$/,
  );
  t.regex(
    fixture.calls[1].url,
    /values:batchGet\?valueRenderOption=UNFORMATTED_VALUE&ranges=Tasks%21A1&ranges=Tasks%21B1$/,
  );
  t.is(fixture.calls[2].init.method, 'PUT');
  t.is(JSON.parse(fixture.calls[2].init.body).majorDimension, 'ROWS');
  t.is(fixture.calls[3].init.method, 'POST');
  t.regex(fixture.calls[3].url, /values:batchUpdate$/);
  t.deepEqual(JSON.parse(fixture.calls[3].init.body).data, [
    {
      range: 'Tasks!A2:B2',
      majorDimension: 'ROWS',
      values: [[3, 4]],
    },
  ]);
  t.regex(fixture.calls[4].url, /values\/Tasks%21A1:append/);
  t.regex(fixture.calls[5].url, /values\/Tasks%21A1%3AC10:clear$/);
  t.regex(fixture.calls[6].url, /includeGridData=false$/);
});

test('returns a hardened client interface', t => {
  const client = makeSheetsClient(async () => response(200, {}), {
    spreadsheetId: 'id',
  });

  t.true(Object.isFrozen(client));
  t.true(Object.isFrozen(client.values));
  t.true(Object.isFrozen(client.spreadsheets));
  t.throws(
    () => {
      client.values.get = async () => undefined;
    },
    { instanceOf: TypeError },
  );
});

test('checks the response status before parsing a successful response', async t => {
  const events = [];
  const client = makeSheetsClient(
    async () => ({
      get ok() {
        events.push('ok');
        return true;
      },
      status: 200,
      headers: new Headers(),
      json: async () => {
        events.push('json');
        return { values: [] };
      },
    }),
    { spreadsheetId: 'id' },
  );

  await client.values.get('A1');
  t.deepEqual(events, ['ok', 'json']);
});

test('maps Google quota errors to structured errors', async t => {
  const client = makeSheetsClient(
    async () =>
      response(
        429,
        {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'slow down',
          },
        },
        { 'retry-after': '12' },
      ),
    { spreadsheetId: 'id' },
  );
  const error = await t.throwsAsync(() => client.values.get('A1'), {
    instanceOf: GoogleSheetsError,
  });
  t.is(error.code, 'quota-exceeded');
  t.is(error.retryAfterSeconds, 12);
  t.is(error.status, 429);
});

test('maps permission and not-found Google errors', async t => {
  const fixture = makeFetch([
    response(403, { error: { status: 'PERMISSION_DENIED', message: 'no' } }),
    response(404, { error: { status: 'NOT_FOUND', message: 'gone' } }),
  ]);
  const client = makeSheetsClient(fixture.fetch, { spreadsheetId: 'id' });
  const denied = /** @type {GoogleSheetsError} */ (
    await t.throwsAsync(() => client.values.get('A1'))
  );
  const missing = /** @type {GoogleSheetsError} */ (
    await t.throwsAsync(() => client.spreadsheets.get())
  );
  t.is(denied.code, 'permission-denied');
  t.is(missing.code, 'not-found');
});
