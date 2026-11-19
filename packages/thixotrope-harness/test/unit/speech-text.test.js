// @ts-check
// The text pipeline of a playback (resources/agent-host/impl/speech/
// {code-filter,speech-text}.js; designs/m11-interfaces.md section 7,
// acceptance 3, probe "a reply of 1 MiB with no punctuation"). The code
// filter cases are Endo's (packages/floot/test/speech-code-filter.test.js at
// 1315bef86), ported; the sentence cases follow R5-35..R5-37.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { audioLimits } from '../../resources/agent-host/impl/speech/audio-protocol.js';
import {
  INSPECTED_LINE_UNITS,
  makeCodeFilter,
} from '../../resources/agent-host/impl/speech/code-filter.js';
import {
  makeSpeechText,
  MIN_SENTENCE_UNITS,
  stripMarkdown,
} from '../../resources/agent-host/impl/speech/speech-text.js';

/**
 * Every sentence of `chunks` pushed in order, then finished.
 * @param {string[]} chunks
 * @param {Parameters<typeof makeSpeechText>[0]} [options]
 */
const speak = (chunks, options) => {
  const text = makeSpeechText(options);
  const out = chunks.flatMap(chunk => text.push(chunk));
  return [...out, ...text.finish()];
};

// ---------------------------------------------------------------- code filter

test('code is never spoken at any delta boundary (Endo)', t => {
  const text =
    'Here is a counter.\n```endowidget\n({h}) => h("button",null,"secret code");\n```\nTry it.';
  for (let split = 0; split <= text.length; split += 1) {
    const filter = makeCodeFilter();
    t.is(
      filter.push(text.slice(0, split)) +
        filter.push(text.slice(split)) +
        filter.finish(),
      'Here is a counter.\n\nTry it.',
    );
  }
});

test('prose is immediate, unfinished code stays silent, inline code stays prose (Endo)', t => {
  const filter = makeCodeFilter();
  t.is(filter.push('Hello. Use `x`.'), 'Hello. Use `x`.');
  t.is(filter.push('\n~~'), '\n');
  t.is(filter.held(), 2, 'a possible fence at a line start is held');
  t.is(filter.push(`~endowidget\n${'secret'.repeat(10_000)}`), '');
  t.is(filter.held(), 0, 'code is discarded, not held');
  t.is(filter.finish(), '');
});

test('a shorter closing fence does not end an outer example (Endo)', t => {
  const filter = makeCodeFilter();
  const code =
    '````markdown\n```endowidget\n() => "hidden"\n```\nstill hidden\n````\nSpeak this.';
  let spoken = '';
  for (const char of code) spoken += filter.push(char);
  t.is(spoken + filter.finish(), '\nSpeak this.');
});

test('only the first 128 units of a line can close a fence', t => {
  const filter = makeCodeFilter();
  const long = `${' '.repeat(INSPECTED_LINE_UNITS)}\`\`\``;
  t.is(
    filter.push(`\`\`\`js\ncode\n${long}\nstill code\n\`\`\`\nSpoken.`),
    '\nSpoken.',
  );
});

// ---------------------------------------------------------------- sentences

test('acceptance 3: a fenced block split across deltas, inline code, links and markdown', t => {
  const reply = [
    '# Plan\nFirst, run `make` in the ',
    '[build directory](https://example.invalid/x). ',
    'It takes **two** minutes.\n``',
    '`sh\nmake all\n``',
    '`\n~~~\nsecret\n~~~\n',
    '- Then *check* the output.\n> Quoted advice here.\n',
    '![logo](a.png) Done for today.',
  ];
  t.deepEqual(speak(reply), [
    'Plan First, run make in the build directory.',
    'It takes two minutes.',
    'Then check the output.',
    'Quoted advice here.',
    'Done for today.',
  ]);
  // No split point changes the result.
  const whole = reply.join('');
  const expected = speak([whole]);
  for (let split = 0; split <= whole.length; split += 7) {
    t.deepEqual(speak([whole.slice(0, split), whole.slice(split)]), expected);
  }
});

test('abbreviations and numbered-list markers do not split', t => {
  t.deepEqual(
    speak([
      'Ask Dr. Smith and Mrs. Jones about St. Ives, etc. today. ',
      'Next one is here.',
    ]),
    [
      'Ask Dr. Smith and Mrs. Jones about St. Ives, etc. today.',
      'Next one is here.',
    ],
  );
  t.deepEqual(speak(['Steps:\n1. Open the door now.\n2. Walk through it.\n']), [
    'Steps: 1. Open the door now.',
    '2. Walk through it.',
  ]);
  // A word that only ends in an abbreviation is no abbreviation.
  t.deepEqual(speak(['We met in the Mast. Then left quickly.']), [
    'We met in the Mast.',
    'Then left quickly.',
  ]);
  // A number after earlier text on its line is no list marker.
  t.deepEqual(speak(['I counted to 2. ', 'Then I stopped counting.']), [
    'I counted to 2.',
    'Then I stopped counting.',
  ]);
});

test('a chunk under 10 units merges with the next', t => {
  t.true(MIN_SENTENCE_UNITS === 10);
  t.deepEqual(speak(['Yes. ', 'No. ', 'I really think so. ', 'Ok.']), [
    'Yes. No. I really think so.',
    'Ok.',
  ]);
});

test('a sentence waits for the whitespace after its mark', t => {
  const text = makeSpeechText();
  t.deepEqual(text.push('The first sentence is here.'), []);
  t.deepEqual(text.push('5 is a number'), [], 'no whitespace: not a boundary');
  t.deepEqual(text.push('. Then'), [
    'The first sentence is here.5 is a number.',
  ]);
  t.deepEqual(text.push(' some more?'), []);
  t.deepEqual(text.push('\t'), ['Then some more?']);
  t.deepEqual(text.finish(), []);
});

test('a line break between rounds ends the sentence and a fence left open', t => {
  const text = makeSpeechText();
  t.deepEqual(text.push('Let me look it up for you'), []);
  t.deepEqual(text.lineBreak(), ['Let me look it up for you']);
  t.deepEqual(text.push('```js\nnever closed'), []);
  t.deepEqual(text.lineBreak(), []);
  t.deepEqual(text.push('Found it, here it is.'), []);
  t.deepEqual(text.finish(), ['Found it, here it is.']);
  // A short chunk is not merged across the break.
  const short = makeSpeechText();
  t.deepEqual(short.push('One. '), []);
  t.deepEqual(short.lineBreak(), ['One.']);
  t.deepEqual(short.push('Two words. '), ['Two words.']);
});

test('pendingUnits counts the held text', t => {
  const text = makeSpeechText();
  text.push('Short');
  t.is(text.pendingUnits(), 5);
  text.push('. ');
  t.is(text.pendingUnits(), 'Short.'.length, 'a merged chunk is held');
  text.push('\n`');
  t.true(text.pendingUnits() >= 'Short.'.length + 1);
  text.finish();
  t.is(text.pendingUnits(), 0);
});

test('stripMarkdown leaves plain prose unchanged', t => {
  t.is(
    stripMarkdown('Plain words, nothing else.'),
    'Plain words, nothing else.',
  );
  t.is(stripMarkdown('a ```x``` b'), 'a   b');
});

test('probe: 1 MiB with no punctuation or newline is cut at whitespace every 1,000 units', t => {
  const text = makeSpeechText();
  const word = 'abcdefgh ';
  let sentences = 0;
  let maxPending = 0;
  let maxSentence = 0;
  const chunk = word.repeat(1000);
  for (let sent = 0; sent < 1024 * 1024; sent += chunk.length) {
    for (const sentence of text.push(chunk)) {
      sentences += 1;
      maxSentence = Math.max(maxSentence, sentence.length);
      t.true(sentence.endsWith('abcdefgh'), 'cut at whitespace');
    }
    maxPending = Math.max(maxPending, text.pendingUnits());
  }
  t.true(maxSentence <= audioLimits.sentenceUnits);
  t.true(sentences > 1000);
  t.true(maxPending <= audioLimits.sentenceUnits + chunk.length);
  t.true(maxPending < audioLimits.sentenceBacklogUnits);
});

test('a run with no whitespace is cut at the bound, never inside a surrogate pair', t => {
  const units = 11;
  const out = speak(['a'.repeat(10), '\u{1F600}', 'b'.repeat(30)], {
    sentenceUnits: units,
  });
  for (const sentence of out) t.true(sentence.length <= units);
  t.is(out.join(''), `${'a'.repeat(10)}\u{1F600}${'b'.repeat(30)}`);
  t.false(out.some(s => /[\ud800-\udbff]$/.test(s)));
});

test('a long reply is split in linear time', t => {
  // 1 MiB of sentences pushed a few units at a time.
  const text = makeSpeechText();
  const reply = 'This is one sentence, Dr. Who said. '.repeat(30_000);
  const started = performance.now();
  let count = 0;
  for (let i = 0; i < reply.length; i += 7) {
    count += text.push(reply.slice(i, i + 7)).length;
  }
  count += text.finish().length;
  const ms = performance.now() - started;
  t.is(count, 30_000);
  t.true(ms < 2000, `took ${ms.toFixed(0)} ms`);
});
