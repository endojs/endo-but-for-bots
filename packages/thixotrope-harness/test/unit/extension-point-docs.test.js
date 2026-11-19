// @ts-check
// The binding plan sends later milestones to the per-session extension
// point that exists: the runtime parts (guest/session/runtime-parts.js).
// Step 3 of the harness review deleted guest/session/turn-hooks.js; the
// shared-file rules, the M6-M13 sections, the ownership check and
// architecture section 4 must not name it as a place to register, and must
// name runtime-parts.js. Historical work-unit tables of built milestones
// (M1a-M5) may still name the file they edited then.
import test from 'ava';
import { existsSync, readFileSync } from 'node:fs';

/** @param {string} path */
const at = path => new URL(`../../${path}`, import.meta.url);
/** @param {string} path */
const read = path => readFileSync(at(path), 'utf8');

/**
 * The text from the first line starting with `start` up to the next line
 * starting with `end` (or the end of the file).
 * @param {string} text
 * @param {string} start
 * @param {string} [end]
 */
const between = (text, start, end) => {
  const from = text.indexOf(`\n${start}`);
  if (from < 0) throw Error(`no section ${start}`);
  const to = end === undefined ? -1 : text.indexOf(`\n${end}`, from + 1);
  return to < 0 ? text.slice(from) : text.slice(from, to);
};

/**
 * The lines that send a reader to the deleted file (not ones saying it is
 * gone).
 * @param {string} section
 */
const sendsToDeleted = section =>
  section
    .split('\n')
    .filter(line => line.includes('turn-hooks'))
    .filter(line => !/deleted|replacing/.test(line));

test('the deleted hook-table file stays deleted', t => {
  t.false(existsSync(at('guest/session/turn-hooks.js')));
  t.true(existsSync(at('guest/session/runtime-parts.js')));
});

test('milestones.md sends M6-M13 to the runtime parts, not turn-hooks.js', t => {
  const plan = read('designs/milestones.md');
  const shared = between(plan, '- **Ownership.**', '- **');
  t.true(shared.includes('runtime-parts.js'));
  t.deepEqual(sendsToDeleted(shared), []);
  const later = between(plan, '## M6.');
  t.deepEqual(sendsToDeleted(later), []);
  for (const name of ['onCancel', 'beforeRound', 'nextTurn', 'onRecover']) {
    t.true(later.includes(name), name);
  }
  t.false(later.includes('turnSources'));
  t.false(later.includes('recoverySteps'));
});

test('architecture.md section 4 names the runtime parts', t => {
  const arch = read('designs/architecture.md');
  const turn = between(arch, '## 4.', '### 4.1');
  t.true(turn.includes('runtime-parts.js'));
  t.deepEqual(sendsToDeleted(turn), []);
});

test('m5-interfaces hook tables send later extenders to parts', t => {
  const m5 = read('designs/m5-interfaces.md');
  const hooks = between(m5, '## 11. Hook tables', '## 12');
  for (const line of hooks
    .split('\n')
    .filter(row => row.includes('turn-hooks') || row.includes('toolSources'))) {
    t.regex(line, /as built after step 3/, line);
  }
});
