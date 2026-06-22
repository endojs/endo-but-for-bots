// islands-ui.test.mjs — the confined-Preact UI kit + the islands factored onto it. These are PURE
// (props)=>vnode components, so we test them by walking the returned vnode tree (no DOM needed): the
// right classes appear, handlers fire with the right args, and conditional UI (reverted vs Revert,
// withDone, attention) renders correctly. NOTE: no `@endo/init` here — preact must load un-lockdowned;
// `node --test` runs each file in its own process so this stays isolated from the SES test files.
//   node --test packages/chat/voice-agent/islands-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chip, Btn, EmptyState, Card } from './client/ui-kit.js';
import { NotificationCard } from './client/notification-card.js';
import { ChangelogList } from './client/changelog-list.js';

// Walk a preact vnode tree → collect text, classes, and clickable buttons (label + handler).
const collect = v => {
  const acc = { text: [], classes: [], buttons: [] };
  const textOf = node => { const a = { text: [], classes: [], buttons: [] }; walk(node, a); return a.text.join(''); };
  function walk(n, a) {
    if (n == null || n === false || n === true) return;
    if (Array.isArray(n)) { for (const c of n) walk(c, a); return; }
    if (typeof n === 'string' || typeof n === 'number') { a.text.push(String(n)); return; }
    const p = (n && n.props) || {};
    if (p.class) a.classes.push(p.class);
    if (typeof p.onClick === 'function') a.buttons.push({ label: textOf(p.children), cls: p.class || '', onClick: p.onClick });
    walk(p.children, a);
  }
  walk(v, acc);
  return acc;
};
const hasClass = (acc, c) => acc.classes.some(cl => String(cl).split(/\s+/).includes(c));
const allText = acc => acc.text.join(' ');

test('kit primitives: Chip / Btn / EmptyState render + Btn fires onClick', () => {
  assert.match(allText(collect(Chip({ label: 'web' }))), /web/);
  assert.ok(hasClass(collect(Chip({ label: 'x', kind: 'bad' })), 'bad'), 'Chip kind → class');
  assert.match(allText(collect(EmptyState({ text: 'nothing' }))), /nothing/);
  let fired = 0;
  const b = collect(Btn({ label: 'Go', onClick: () => { fired += 1; } }));
  assert.equal(b.buttons.length, 1); b.buttons[0].onClick();
  assert.equal(fired, 1, 'Btn onClick fires');
});

test('Card shell: title/time/body render, attention adds .att, cls overrides the shell class', () => {
  const acc = collect(Card({ cls: 'notif', title: 'Hello', time: '2m', body: 'world', attention: true }));
  assert.ok(hasClass(acc, 'notif') && hasClass(acc, 'att'), 'notif + att classes');
  assert.match(allText(acc), /Hello/); assert.match(allText(acc), /2m/); assert.match(allText(acc), /world/);
});

test('NotificationCard: attention, body/agent/status, Done → onDone(id), links → onOpenLink(index)', () => {
  let doneId = null; const openLinks = [];
  const acc = collect(NotificationCard({
    id: 'n1', title: 'Voice note', time: '2m', body: 'book flights', agent: 'capture', status: 'needs input',
    links: [{ label: '💬 chat' }, { label: '📎 file' }], attention: true, withDone: true,
    onDone: id => { doneId = id; }, onOpenLink: i => openLinks.push(i),
  }));
  assert.ok(hasClass(acc, 'notif') && hasClass(acc, 'att'));
  const t = allText(acc);
  for (const s of ['Voice note', 'book flights', 'capture', 'needs input']) assert.match(t, new RegExp(s));
  const done = acc.buttons.find(b => b.cls.includes('ndone')); assert.ok(done, 'Done button'); done.onClick();
  assert.equal(doneId, 'n1', 'onDone called with id');
  const links = acc.buttons.filter(b => b.cls.includes('nlink')); assert.equal(links.length, 2, 'two link buttons');
  links[0].onClick(); links[1].onClick();
  assert.deepEqual(openLinks, [0, 1], 'onOpenLink called with link index');
});

test('NotificationCard: NO Done button when withDone is false (the cap/swissnum never enters the card)', () => {
  const acc = collect(NotificationCard({ id: 'n2', title: 'x', links: [], withDone: false, onDone() {} }));
  assert.equal(acc.buttons.filter(b => b.cls.includes('ndone')).length, 0);
});

test('ChangelogList: empty state; a live row shows Revert → onRevert(id); a reverted row shows a pill, no button', () => {
  assert.match(allText(collect(ChangelogList({ merges: [] }))), /no self-applied changes/);
  let reverted = null;
  const acc = collect(ChangelogList({
    merges: [
      { id: 'm1', goal: 'add clearResolved()', when: 'today', sha: 'a1b2c3d4', rolledBack: false },
      { id: 'm2', goal: 'add backlogStats()', when: 'yesterday', sha: '9f8e7d6c', rolledBack: true, revertedWhen: 'today' },
    ],
    onRevert: id => { reverted = id; },
  }));
  const t = allText(acc);
  assert.match(t, /add clearResolved/); assert.match(t, /a1b2c3d4/); assert.match(t, /reverted/);
  const revertBtns = acc.buttons.filter(b => /Revert/.test(b.label));
  assert.equal(revertBtns.length, 1, 'only the LIVE row has a Revert button (the reverted one shows a pill)');
  revertBtns[0].onClick();
  assert.equal(reverted, 'm1', 'onRevert called with the live merge id');
});
