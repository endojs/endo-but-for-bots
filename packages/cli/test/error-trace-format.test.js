// @ts-nocheck
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';

import {
  printTraceReport,
  recordInboundErrorId,
  extractErrorId,
  isErrorPrinted,
  markErrorPrinted,
} from '../src/error-trace.js';

// SES freezes `console`, so capture stderr by intercepting process.stderr.write
// (which console.error ultimately calls through Node's internals).
const captureStderr = fn => {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
};

const baseReport = overrides => ({
  errorId: 'error:Endo#42',
  workerId: 'w-formatter',
  name: 'Error',
  message: 'boom',
  stack: 'Error: boom\n    at fake.js:1:1',
  annotations: [],
  causes: [],
  related: [],
  t: 0,
  site: 'marshal',
  partial: false,
  ...overrides,
});

test('printTraceReport renders annotations under the trace header', t => {
  const out = captureStderr(() =>
    printTraceReport(
      baseReport({
        annotations: ['Sent as error:captp:CLI#1', 'observed at vat-A'],
      }),
    ),
  );
  t.regex(out, /annotations:/);
  t.regex(out, /Sent as error:captp:CLI#1/);
  t.regex(out, /observed at vat-A/);
});

test('printTraceReport renders causes with worker id and per-cause stack', t => {
  const out = captureStderr(() =>
    printTraceReport(
      baseReport({
        message: 'outer',
        causes: [
          {
            errorId: 'error:Endo#7',
            workerId: 'w-inner',
            name: 'TypeError',
            message: 'inner',
            stack: 'TypeError: inner\n    at inner.js:9:9',
            annotations: ['inner-note'],
            partial: false,
          },
        ],
      }),
    ),
  );
  t.regex(out, /caused by:/);
  t.regex(out, /error:Endo#7 worker=w-inner/);
  t.regex(out, /TypeError: inner/);
  t.regex(out, /inner.js:9:9/);
  // Cause-level annotations also render.
  t.regex(out, /- inner-note/);
});

test('printTraceReport flags partial in both header and causes', t => {
  const out = captureStderr(() =>
    printTraceReport(
      baseReport({
        partial: true,
        causes: [
          {
            errorId: 'error:Endo#missing',
            workerId: '',
            name: 'Error',
            message: 'lost',
            stack: '',
            annotations: [],
            partial: true,
          },
        ],
      }),
    ),
  );
  t.regex(out, /Trace error:Endo#42 \(partial\)/);
  t.regex(out, /error:Endo#missing \(partial\) worker=@daemon/);
});

test('printTraceReport renders compartmentId when present', t => {
  const out = captureStderr(() =>
    printTraceReport(baseReport({ compartmentId: 'compartment-9' })),
  );
  t.regex(out, /compartment: compartment-9/);
});

test('extractErrorId prefers the inbound-side-table over the SES tag', t => {
  const err = new Error('boom');
  err.name = 'Error(error:Endo#tag-only)';
  // Without side-table recording, falls back to the SES tag.
  t.is(extractErrorId(err), 'error:Endo#tag-only');
  // After recordInboundErrorId, the side-table value wins.
  recordInboundErrorId(err, 'error:Endo#side-table');
  t.is(extractErrorId(err), 'error:Endo#side-table');
});

test('extractErrorId returns undefined for non-objects and missing tags', t => {
  t.is(extractErrorId(undefined), undefined);
  t.is(extractErrorId(null), undefined);
  t.is(extractErrorId('not-an-error'), undefined);
  t.is(extractErrorId({}), undefined);
  // An error whose name has no SES tag and no side-table entry.
  const err = new Error('plain');
  t.is(extractErrorId(err), undefined);
});

test('markErrorPrinted and isErrorPrinted are idempotent on the same Error', t => {
  const err = new Error('once');
  t.is(isErrorPrinted(err), false);
  markErrorPrinted(err);
  t.is(isErrorPrinted(err), true);
  // Marking again is a no-op.
  markErrorPrinted(err);
  t.is(isErrorPrinted(err), true);
  // A different Error is independent.
  t.is(isErrorPrinted(new Error('other')), false);
});
