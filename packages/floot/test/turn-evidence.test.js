// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { UNSETTLED_TOOL_RESULT } from '../src/hosted-turn.js';
import {
  UNKNOWN_TOOL_OUTCOME,
  isUnansweredResult,
  reconcileTurnEvidence,
} from '../src/turn-evidence.js';

/**
 * The journal's own text reader: whole content, nothing cut.
 *
 * @param {any} raw
 */
const whole = raw => ({ args: raw.args, result: raw.result });

/**
 * The history reader's: previews, with what was cut marked.
 *
 * @param {any} raw
 */
const previews = raw => ({
  args: raw.args,
  result: raw.result,
  cut: { args: raw.argsRef !== undefined, result: raw.resultRef !== undefined },
});

const shape = rows =>
  rows.map(row => [row.source, row.id, row.result, row.settledBy ?? null]);

test('a completed turn: the observation and the execution of each mirrored call match it, one to one', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: [
      { id: 'a', name: 'exec', args: '{}', result: 'ok' },
      { id: 'b', name: 'exec', args: '{}', result: 'ok' },
    ],
    activity: [
      { callId: 'a', name: 'exec', args: '{}', result: 'ok', settled: true },
      { callId: 'b', name: 'exec', args: '{}', result: 'ok', settled: true },
    ],
    tools: [
      { callId: 'x', name: 'exec', args: '{}', result: 'ok', settled: true },
      { callId: 'y', name: 'exec', args: '{}', result: 'ok', settled: true },
    ],
    read: whole,
  });
  t.deepEqual(shape(rows), [
    ['tree', 'a', 'ok', null],
    ['tree', 'b', 'ok', null],
  ]);
  t.true(rows.every(row => row.observed && row.executed));
});

test('an observation matches by native id alone; a look-alike under another id is its own evidence', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: [{ id: 'a', name: 'exec', args: '{}' }],
    activity: [
      { callId: 'z', name: 'exec', args: '{}', result: 'other', settled: true },
    ],
    read: whole,
  });
  t.deepEqual(shape(rows), [
    ['tree', 'a', undefined, null],
    ['guest', 'z', 'other', null],
  ]);
});

test('reordered observations settle native identities, not identical arguments', async t => {
  const base = { name: 'exec', args: '{}', settled: true };
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: ['a', 'b', 'c'].map(id => ({ id, name: 'exec', args: '{}' })),
    activity: [
      { ...base, callId: 'b', result: 'second' },
      { ...base, callId: 'a', result: 'first' },
      { ...base, callId: 'c', settled: false },
    ],
    tools: [
      { ...base, callId: 'x', result: 'second' },
      { ...base, callId: 'y', result: 'first' },
    ],
    read: whole,
  });
  t.deepEqual(shape(rows), [
    ['tree', 'a', 'first', 'guest'],
    ['tree', 'b', 'second', 'guest'],
    ['tree', 'c', undefined, null],
  ]);
  // Both executions found the settled call that reproduces their result.
  t.deepEqual(
    rows.map(row => row.executed),
    [true, true, false],
  );
});

test('an execution nothing mirrored is recovered under an id namespaced to the turn, never aliasing a native one', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '7',
    known: [
      // A native call under the execution's own id, for another tool.
      { id: 'x', name: 'other', args: '{}', result: 'ok' },
      // Whatever id the tree holds, a recovered id is re-prefixed until it
      // is free.
      { id: 'recovered:7:y', name: 'other', args: '{}', result: 'ok' },
    ],
    tools: [
      {
        callId: 'x',
        name: 'effect',
        args: '{}',
        result: 'done',
        settled: true,
      },
      { callId: 'y', name: 'effect', args: '{}', settled: false },
    ],
    read: whole,
  });
  t.deepEqual(shape(rows), [
    ['tree', 'x', 'ok', null],
    ['tree', 'recovered:7:y', 'ok', null],
    ['host', 'recovered:7:x', 'done', null],
    ['host', 'recovered:recovered:7:y', undefined, null],
  ]);
  t.false(rows[3].settled);
});

test('an execution that never settled answers the call still waiting, not a settled look-alike', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: [
      { id: 'a', name: 'exec', args: '{}', result: 'x' },
      { id: 'b', name: 'exec', args: '{}', result: UNSETTLED_TOOL_RESULT },
    ],
    tools: [
      { callId: 't1', name: 'exec', args: '{}', settled: false },
      { callId: 't2', name: 'exec', args: '{}', result: 'x', settled: true },
    ],
    read: whole,
  });
  // The journal says one execution never reported; the settled one settles
  // nothing the tree left open.
  t.deepEqual(shape(rows), [
    ['tree', 'a', 'x', null],
    ['tree', 'b', UNSETTLED_TOOL_RESULT, null],
  ]);
  t.deepEqual(
    rows.map(row => row.executed),
    [true, true],
  );
  // With no call waiting, an unsettled execution is still one of the calls
  // made, whichever way its result went.
  const settled = await reconcileTurnEvidence({
    turnId: '1',
    known: [{ id: 'a', name: 'exec', args: '{}', result: 'x' }],
    tools: [{ callId: 't1', name: 'exec', args: '{}', settled: false }],
    read: whole,
  });
  t.deepEqual(shape(settled), [['tree', 'a', 'x', null]]);
  t.true(settled[0].executed);
});

test('a settled execution wins its call whatever order the journal started them in', async t => {
  // An MCP bridge retry after a timeout: one call in the tree, answered; two
  // executions in the journal, the hung one first. The settled one is the
  // call; the hung one stays visible as an execution that never reported.
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: [{ id: 'a', name: 'exec', args: '{}', result: 'x' }],
    tools: [
      { callId: 't1', name: 'exec', args: '{}', settled: false },
      { callId: 't2', name: 'exec', args: '{}', result: 'x', settled: true },
    ],
    read: whole,
  });
  t.deepEqual(shape(rows), [
    ['tree', 'a', 'x', null],
    ['host', 'recovered:1:t1', undefined, null],
  ]);
  t.false(rows[1].settled);
  // With the call unanswered in the tree, the settled execution answers it
  // rather than the hung one silently occupying it.
  const open = await reconcileTurnEvidence({
    turnId: '1',
    known: [
      { id: 'a', name: 'exec', args: '{}', result: UNSETTLED_TOOL_RESULT },
    ],
    tools: [
      { callId: 't1', name: 'exec', args: '{}', settled: false },
      { callId: 't2', name: 'exec', args: '{}', result: 'x', settled: true },
    ],
    read: whole,
  });
  t.deepEqual(shape(open), [
    ['tree', 'a', 'x', 'host'],
    ['host', 'recovered:1:t1', undefined, null],
  ]);
});

test('an execution answers an observation the tree never mirrored; a null result is unanswered', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '2',
    known: [{ id: 'k', name: 'exec', args: '{}', result: null }],
    activity: [
      // The journal kept a preview of the observation's arguments.
      {
        callId: 'n1',
        name: 'exec',
        args: '{"path":"long',
        argsRef: { id: 'r' },
        settled: false,
      },
    ],
    tools: [
      {
        callId: 'e1',
        name: 'exec',
        args: '{"path":"long-enough"}',
        result: 'done',
        settled: true,
      },
      {
        callId: 'e2',
        name: 'exec',
        args: '{}',
        result: 'k done',
        settled: true,
      },
    ],
    read: previews,
  });
  t.deepEqual(shape(rows), [
    ['tree', 'k', 'k done', 'host'],
    ['guest', 'n1', 'done', 'host'],
  ]);
  t.true(rows[0].settled && rows[1].settled);
  t.true(rows[1].observed && rows[1].executed);
  // The settled result is whole; the observation's arguments stay a preview.
  t.deepEqual(rows[1].cut, { args: true, result: false });
});

test('an execution answers an unanswered mirrored call with the same arguments and settles it', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: [
      { id: 'a', name: 'exec', args: '{}', result: UNSETTLED_TOOL_RESULT },
    ],
    tools: [
      { callId: 'x', name: 'exec', args: '{}', result: 'done', settled: true },
    ],
    read: whole,
  });
  t.deepEqual(shape(rows), [['tree', 'a', 'done', 'host']]);
  t.true(isUnansweredResult(UNSETTLED_TOOL_RESULT));
  t.true(isUnansweredResult(UNKNOWN_TOOL_OUTCOME));
  t.true(isUnansweredResult(null));
  t.false(isUnansweredResult(''));
  // A journal entry without a call id is refused, not coerced to one.
  await t.throwsAsync(
    () =>
      reconcileTurnEvidence({
        turnId: '1',
        known: [],
        tools: [{ name: 'exec', args: '{}', settled: false }],
        read: whole,
      }),
    { message: /call id must be a non-empty string/ },
  );
});

test('the Claude MCP alias is the same tool, and previews match their wholes', async t => {
  const args = JSON.stringify({ code: 'x'.repeat(13_429) });
  const result = 'a'.repeat(278);
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: [{ id: 'native-0', name: 'mcp__endo__exec', args, result }],
    activity: [
      {
        callId: 'native-0',
        name: 'mcp__endo__exec',
        args,
        result,
        settled: true,
      },
    ],
    // The journal kept previews of the long argument and result.
    tools: [
      {
        callId: 'executor-0',
        name: 'exec',
        args: `${args.slice(0, 8192)}`,
        argsRef: { id: 'ref' },
        result: result.slice(0, 100),
        resultRef: { id: 'ref' },
        settled: true,
      },
    ],
    read: previews,
  });
  t.deepEqual(shape(rows), [['tree', 'native-0', result, null]]);
  t.true(rows[0].observed && rows[0].executed);
});

test('an execution with a different result than the observation of the same call is a second row, not a substitute', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '1',
    known: [{ id: 'a', name: 'exec', args: '{}', result: 'one' }],
    activity: [
      { callId: 'a', name: 'exec', args: '{}', result: 'one', settled: true },
    ],
    tools: [
      { callId: 'x', name: 'exec', args: '{}', result: 'two', settled: true },
    ],
    read: whole,
  });
  t.deepEqual(shape(rows), [
    ['tree', 'a', 'one', null],
    ['host', 'recovered:1:x', 'two', null],
  ]);
});

test('with nothing mirrored, observations come first under their ids and executions after; an unqualified name is not the MCP alias', async t => {
  const rows = await reconcileTurnEvidence({
    turnId: '3',
    known: [],
    activity: [
      {
        callId: 'n1',
        name: 'endo_effect',
        args: '{}',
        result: 'once',
        settled: true,
      },
    ],
    tools: [
      {
        callId: 'e1',
        name: 'effect',
        args: '{}',
        result: 'once',
        settled: true,
      },
      { callId: 'e2', name: 'effect', args: '{"k":1}', settled: false },
    ],
    read: whole,
  });
  // `endo_effect` is not `mcp__endo__effect`: the observation and the
  // execution stay two rows, as the history shows them.
  t.deepEqual(shape(rows), [
    ['guest', 'n1', 'once', null],
    ['host', 'recovered:3:e1', 'once', null],
    ['host', 'recovered:3:e2', undefined, null],
  ]);
});
