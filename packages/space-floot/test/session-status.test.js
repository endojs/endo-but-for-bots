// @ts-check
import fs from 'node:fs';
import test from 'ava';

import {
  sessionRuntimeLabel,
  sessionStatusOf,
} from '../src/SessionSidebar.js';

test('every session resolves to one of the three circle states', t => {
  t.is(sessionStatusOf({}), 'passive', 'no status is passive, not blank');
  t.is(sessionStatusOf({ status: 'passive' }), 'passive');
  t.is(sessionStatusOf({ status: 'idle' }), 'passive');
  t.is(sessionStatusOf({ status: 'working' }), 'working');
  t.is(sessionStatusOf({ status: 'streaming' }), 'working');
  t.is(sessionStatusOf({ status: 'error' }), 'error');
  t.is(
    sessionStatusOf({ status: /** @type {any} */ ('x y') }),
    'passive',
    'an unrecognised status never becomes a class name',
  );
});

test('a session that is not ready is an error whatever its turn is doing', t => {
  t.is(sessionStatusOf({ status: 'working', lifecycle: 'error' }), 'error');
  t.is(sessionStatusOf({ lifecycle: 'deleting' }), 'error');
  t.is(sessionStatusOf({ status: 'working', lifecycle: 'ready' }), 'working');
});

test('a row says what the session runs on', t => {
  t.is(
    sessionRuntimeLabel({ backendLabel: 'Codex', modelLabel: 'GPT-5' }),
    'Codex · GPT-5',
  );
  t.is(
    sessionRuntimeLabel({
      backendLabel: 'Codex',
      modelLabel: 'GPT-5',
      reasoningEffort: 'high',
    }),
    'Codex · GPT-5 high',
  );
  t.is(sessionRuntimeLabel({ backendLabel: 'Fae' }), 'Fae');
  t.is(sessionRuntimeLabel({}), '', 'an older host draws no runtime line');
});

// The space renders inside chat's page, and its stylesheet is bundled into the
// same document (no shadow root). Chat styles a handful of bare class names —
// `.error` gets padding, a border and a monospace face, for error values in
// messages — so a Floot element carrying one of those names inherits all of
// it: the status circle became an ellipse that way. The names are read from
// chat's stylesheet rather than guessed, so a rule added there is covered.
const chatCss = fs
  .readFileSync(new URL('../../chat/index.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const bareGlobals = new Set();
for (const block of chatCss.matchAll(/(^|[{}])([^{}@]+)\{/g)) {
  for (const selector of block[2].split(',')) {
    const match = /^\s*\.([A-Za-z_][\w-]*)\s*$/.exec(selector);
    if (match) bareGlobals.add(match[1]);
  }
}
// Reused on purpose: a highlighted token takes chat's token colours.
const ALLOWED = new Set(['token']);
const forbidden = [...bareGlobals].filter(name => !ALLOWED.has(name));

test('chat really does style a bare .error (the premise of these tests)', t => {
  t.true(bareGlobals.has('error'));
  t.true(forbidden.length > 1);
});

test('the stylesheet uses no class name the host page styles bare', t => {
  const css = fs
    .readFileSync(new URL('../src/floot.css', import.meta.url), 'utf8')
    // Comments may name the class they warn about.
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const used = new Set(
    [...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]),
  );
  t.deepEqual(
    forbidden.filter(name => used.has(name)),
    [],
  );
});

test('no component writes a class name the host page styles bare', t => {
  const dir = new URL('../src/', import.meta.url);
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.js')) {
      const source = fs.readFileSync(new URL(name, dir), 'utf8');
      // Each `class:` expression, which in this code base is a string or a
      // template literal spanning at most a few lines.
      for (const match of source.matchAll(/class:\s*([\s\S]{0,240})/g)) {
        // The expression ends at the comma that closes the property.
        // or at the brace that closes a one-line props object.
        const expression = match[1].split(/,\n|\s\}[,)]/)[0];
        // The whole expression, not its string literals: a template literal
        // with nested quotes does not split cleanly. A property access
        // (`turn.error`, `voice.micError`) is not a class name, so a word
        // preceded by `.`, `-` or a word character does not count.
        for (const word of forbidden) {
          if (new RegExp(`(?<![\\w.-])${word}(?![\\w-])`).test(expression)) {
            offenders.push(`${name}: ${word} in ${expression.slice(0, 60)}`);
          }
        }
      }
    }
  }
  t.deepEqual(offenders, []);
});

test('a class built from a runtime value is drawn from a closed set', t => {
  // The original defect was not a literal: the sidebar wrote the status
  // straight into the class. The scan above cannot see a runtime value, so the
  // one place that still does it is pinned to values chat does not style.
  for (const status of ['passive', 'working', 'error']) {
    t.false(bareGlobals.has(`floot-status-dot-${status}`));
  }
  for (const role of ['user', 'assistant', 'tool']) {
    t.false(bareGlobals.has(role), `MessageList writes the role "${role}" bare`);
  }
});
