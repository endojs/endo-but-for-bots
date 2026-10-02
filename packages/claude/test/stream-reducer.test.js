// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeClaudeStreamReducer } from '../src/stream-reducer.js';
import { assistant, line, successResult } from './_backend-fixtures.js';

/**
 * @param {string} text
 */
const reduce = text => {
  const reducer = makeClaudeStreamReducer();
  reducer.pushText(text);
  return reducer.finish();
};

test('a success result yields its text and usage', t => {
  const reduction = reduce(
    `${assistant('m1', 'draft')}${successResult({
      result: 'final',
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 6,
      },
    })}`,
  );
  t.is(reduction.terminal, 'success');
  t.is(reduction.text, 'final');
  t.is(reduction.turns, 1);
  t.deepEqual(reduction.usage, {
    inputTokens: 3,
    outputTokens: 4,
    cacheReadTokens: 5,
    cacheWriteTokens: 6,
    turns: 2,
    durationMs: 40,
  });
});

test('without a result string the assistant text stands in', t => {
  const reduction = reduce(
    `${assistant('m1', 'a')}${assistant('m2', 'b')}${successResult({
      result: undefined,
    })}`,
  );
  t.is(reduction.text, 'ab');
});

test('turns count distinct assistant messages, across chunk boundaries', t => {
  const reducer = makeClaudeStreamReducer();
  const text = `${assistant('m1', 'a')}${assistant('m1', 'b')}${assistant(
    'm2',
    'c',
  )}`;
  const middle = Math.floor(text.length / 2);
  const began = reducer.pushText(text.slice(0, middle));
  t.is(began + reducer.pushText(text.slice(middle)), 2);
  t.is(reducer.finish().turns, 2);
});

test('assistant events without a message id each count as a turn', t => {
  const anonymous = line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x' }] },
  });
  const reduction = reduce(
    `${anonymous}${anonymous}${assistant('m1', 'y')}${successResult({
      result: undefined,
    })}`,
  );
  t.is(reduction.turns, 3);
  t.is(reduction.text, 'xxy');
});

test('a blank line between events is skipped, not parsed', t => {
  const reduction = reduce(
    `${assistant('m1', 'a')}\n${successResult({ result: undefined })}`,
  );
  t.is(reduction.terminal, 'success');
  t.is(reduction.turns, 1);
});

test('an assistant event with no message field contributes no text and still counts a turn', t => {
  const reduction = reduce(
    `${line({ type: 'assistant' })}${successResult({ result: undefined })}`,
  );
  t.is(reduction.text, '');
  t.is(reduction.turns, 1);
});

test('error_max_turns is the max-turns terminal', t => {
  t.is(
    reduce(line({ type: 'result', subtype: 'error_max_turns', is_error: true }))
      .terminal,
    'max-turns',
  );
});

test('an error result keeps the raw event for classification', t => {
  const reduction = reduce(
    line({ type: 'result', subtype: 'error_during_execution', is_error: true }),
  );
  t.is(reduction.terminal, 'error');
  t.is(reduction.resultEvent?.subtype, 'error_during_execution');
});

test('a success subtype flagged is_error is an error', t => {
  t.is(reduce(successResult({ is_error: true })).terminal, 'error');
});

test('no result event is missing', t => {
  t.is(reduce(assistant('m1', 'partial')).terminal, 'missing');
});

test('an unparseable line makes the stream malformed', t => {
  const reduction = reduce(`${successResult()}{"type":`);
  t.is(reduction.terminal, 'malformed');
  t.is(reduction.detail, 'line 2 is not JSON');
});

test('two terminal results make the stream malformed', t => {
  const reduction = reduce(`${successResult()}${successResult()}`);
  t.is(reduction.terminal, 'malformed');
  t.is(reduction.detail, '2 terminal result events');
});

test("a background task's result is not the turn's", t => {
  const reduction = reduce(
    `${line({
      type: 'result',
      subtype: 'success',
      result: 'task',
      origin: { kind: 'task-notification' },
    })}${successResult({ result: 'turn' })}`,
  );
  t.is(reduction.terminal, 'success');
  t.is(reduction.text, 'turn');
});

test('pushEvent accepts SDK message objects', t => {
  const reducer = makeClaudeStreamReducer();
  t.true(reducer.pushEvent({ type: 'assistant', message: { id: 'm1' } }));
  t.false(reducer.pushEvent({ type: 'assistant', message: { id: 'm1' } }));
  reducer.pushEvent({ type: 'result', subtype: 'success', result: 'ok' });
  t.like(reducer.finish(), { terminal: 'success', text: 'ok', turns: 1 });
  const strange = makeClaudeStreamReducer();
  strange.pushEvent('not an event');
  t.is(strange.finish().terminal, 'malformed');
});
