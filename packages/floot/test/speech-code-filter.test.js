// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeSpeechCodeFilter } from '../src/speech-code-filter.js';

test('widget code is never spoken at any delta boundary', t => {
  const text =
    'Here is a counter.\n```endowidget\n({h}) => h("button",null,"secret code");\n```\nTry it.';
  for (let split = 0; split <= text.length; split += 1) {
    const filter = makeSpeechCodeFilter();
    t.is(
      filter.push(text.slice(0, split)) +
        filter.push(text.slice(split)) +
        filter.finish(),
      'Here is a counter.\n\nTry it.',
    );
  }
});

test('prose is immediate, unfinished code stays silent, inline code remains prose', t => {
  const filter = makeSpeechCodeFilter();
  t.is(filter.push('Hello. Use `x`.'), 'Hello. Use `x`.');
  t.is(filter.push('\n~~'), '\n');
  t.is(filter.push(`~endowidget\n${'secret'.repeat(10_000)}`), '');
  t.is(filter.finish(), '');
});

test('a shorter closing fence does not expose an outer code example to speech', t => {
  const filter = makeSpeechCodeFilter();
  const code =
    '````markdown\n```endowidget\n() => "hidden"\n```\nstill hidden\n````\nSpeak this.';
  let spoken = '';
  for (const char of code) spoken += filter.push(char);
  t.is(spoken + filter.finish(), '\nSpeak this.');
});
