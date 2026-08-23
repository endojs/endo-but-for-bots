/** @import { SheetsClient } from '../types.js' */

const DEFAULT_BASE_URL = 'https://sheets.googleapis.com/v4';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
// Google Sheets represents dates as "serial numbers": the whole part counts
// days since the epoch of December 30, 1899, following the Lotus 1-2-3 / Excel
// "1900 date system" (which includes the fictitious February 29, 1900). See the
// SERIAL_NUMBER definition in the Sheets API DateTimeRenderOption reference:
// https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/DateTimeRenderOption
// 25569 is the number of days from that epoch to the Unix epoch of
// January 1, 1970, so subtracting it converts a Sheets serial to Unix days.
const SHEETS_EPOCH_OFFSET = 25_569;

/** @param {number} serial */
export const serialToISO8601 = serial => {
  if (!Number.isFinite(serial)) {
    throw new TypeError('Sheets serial date must be a finite number');
  }
  return new Date(
    (serial - SHEETS_EPOCH_OFFSET) * MILLISECONDS_PER_DAY,
  ).toISOString();
};

/** @param {string} iso8601 */
export const iso8601ToSerial = iso8601 => {
  const milliseconds = Date.parse(iso8601);
  if (Number.isNaN(milliseconds)) {
    throw new TypeError('Expected an ISO 8601 date');
  }
  return milliseconds / MILLISECONDS_PER_DAY + SHEETS_EPOCH_OFFSET;
};

/**
 * Encodes an A1 range for use as one URL path segment.
 *
 * @param {string} range
 */
export const encodeA1Range = range => {
  if (typeof range !== 'string' || range.length === 0) {
    throw new TypeError('A1 range must be a non-empty string');
  }
  // encodeURIComponent intentionally leaves a few URI punctuation characters
  // alone. They are significant in a Sheets range, so encode them too.
  return encodeURIComponent(range).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
};

/** A structured failure returned by the Google Sheets API. */
export class GoogleSheetsError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, status: number, retryAfterSeconds?: number, details?: unknown }} options
   */
  constructor(message, { code, status, retryAfterSeconds, details }) {
    super(message);
    this.name = 'GoogleSheetsError';
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * @param {number} status
 * @param {string | undefined} googleStatus
 */
const errorCodeFor = (status, googleStatus) => {
  if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    return 'quota-exceeded';
  }
  if (status === 403 || googleStatus === 'PERMISSION_DENIED') {
    return 'permission-denied';
  }
  if (status === 404 || googleStatus === 'NOT_FOUND') {
    return 'not-found';
  }
  if (status === 401 || googleStatus === 'UNAUTHENTICATED') {
    return 'unauthenticated';
  }
  if (status === 400 || googleStatus === 'INVALID_ARGUMENT') {
    return 'invalid-argument';
  }
  return 'google-sheets-error';
};

/** @param {{ get?: (name: string) => string | null } | undefined} headers */
const retryAfterFrom = headers => {
  if (!headers || typeof headers.get !== 'function') return undefined;
  const value = headers.get('retry-after');
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

/**
 * Makes a client that has exactly the network authority granted by fetch.
 * It deliberately neither accepts nor constructs authorization headers.
 *
 * @param {(url: string, init?: object) => Promise<any>} fetch
 * @param {{ spreadsheetId: string, baseUrl?: string }} options
 */
export const makeSheetsClient = (
  fetch,
  { spreadsheetId, baseUrl = DEFAULT_BASE_URL },
) => {
  if (typeof fetch !== 'function') {
    throw new TypeError('makeSheetsClient requires a fetch function');
  }
  if (typeof spreadsheetId !== 'string' || spreadsheetId.length === 0) {
    throw new TypeError('spreadsheetId must be a non-empty string');
  }
  const root = `${baseUrl.replace(/\/$/, '')}/spreadsheets/${encodeURIComponent(spreadsheetId)}`;

  /**
   * @param {string} path
   * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown }} [request]
   */
  const call = async (path, request = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query || {})) {
      if (value === undefined || value === null) {
        // Omit unspecified optional query parameters.
      } else if (Array.isArray(value)) {
        for (const item of value) query.append(key, String(item));
      } else {
        query.set(key, String(value));
      }
    }
    const url = `${root}${path}${query.size ? `?${query}` : ''}`;
    const init = { method: request.method || 'GET' };
    if (request.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(request.body);
    }
    const response = await fetch(url, init);
    if (!response.ok) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      const error = payload && payload.error ? payload.error : payload || {};
      const status = Number(error.code) || Number(response.status) || 0;
      const retryAfterSeconds = retryAfterFrom(response.headers);
      throw new GoogleSheetsError(
        error.message || `Google Sheets request failed (${status})`,
        {
          code: errorCodeFor(status, error.status),
          status,
          retryAfterSeconds,
          details: error.details,
        },
      );
    }
    return response.json();
  };

  const values = harden({
    get: (range, options = {}) =>
      call(`/values/${encodeA1Range(range)}`, {
        query: { valueRenderOption: 'UNFORMATTED_VALUE', ...options },
      }),
    batchGet: (ranges, options = {}) => {
      if (!Array.isArray(ranges) || ranges.length === 0) {
        throw new TypeError('ranges must be a non-empty array');
      }
      return call('/values:batchGet', {
        query: { valueRenderOption: 'UNFORMATTED_VALUE', ...options, ranges },
      });
    },
    update: (range, valuesToWrite, options = {}) =>
      call(`/values/${encodeA1Range(range)}`, {
        method: 'PUT',
        query: { valueInputOption: 'USER_ENTERED', ...options },
        body: { range, majorDimension: 'ROWS', values: valuesToWrite },
      }),
    batchUpdate: (updates, options = {}) => {
      if (!Array.isArray(updates) || updates.length === 0) {
        throw new TypeError('updates must be a non-empty array');
      }
      return call('/values:batchUpdate', {
        method: 'POST',
        body: {
          valueInputOption: 'USER_ENTERED',
          ...options,
          data: updates.map(({ range, values: valuesToWrite }) => ({
            range,
            majorDimension: 'ROWS',
            values: valuesToWrite,
          })),
        },
      });
    },
    append: (range, valuesToAppend, options = {}) =>
      call(`/values/${encodeA1Range(range)}:append`, {
        method: 'POST',
        query: { valueInputOption: 'USER_ENTERED', ...options },
        body: { range, majorDimension: 'ROWS', values: valuesToAppend },
      }),
    clear: (range, options = {}) =>
      call(`/values/${encodeA1Range(range)}:clear`, {
        method: 'POST',
        query: options,
        body: {},
      }),
  });

  const spreadsheets = harden({
    get: (options = {}) => call('', { query: options }),
  });

  return /** @satisfies {SheetsClient} */ (
    harden({
      values,
      spreadsheets,
      getValues: values.get,
      batchGetValues: values.batchGet,
      updateValues: values.update,
      batchUpdateValues: values.batchUpdate,
      appendValues: values.append,
      clearValues: values.clear,
      getSpreadsheet: spreadsheets.get,
    })
  );
};

harden(encodeA1Range);
harden(GoogleSheetsError);
harden(makeSheetsClient);
