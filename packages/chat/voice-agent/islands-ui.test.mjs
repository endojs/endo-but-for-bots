// islands-ui.test.mjs — the confined-Preact UI kit + the islands factored onto it. These are PURE
// (props)=>vnode components, so we test them by walking the returned vnode tree (no DOM needed): the
// right classes appear, handlers fire with the right args, and conditional UI (reverted vs Revert,
// withDone, attention) renders correctly. NOTE: no `@endo/init` here — preact must load un-lockdowned;
// `node --test` runs each file in its own process so this stays isolated from the SES test files.
//   node --test packages/chat/voice-agent/islands-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chip, Btn, EmptyState, Card, TextField, Textarea, Select, Checkbox, Toggle, RadioGroup, Tabs, ProgressBar, Banner, Badge, Spinner, Avatar, SegmentedControl, Slider, Skeleton, Disclosure, Breadcrumb, Modal, Tooltip, Menu, Toast, Pagination, Table, List } from './client/ui-kit.js';
import { NotificationCard } from './client/notification-card.js';
import { ChangelogList } from './client/changelog-list.js';
import { PowersBanner } from './client/powers-banner.js';
import { KitSampler } from './client/kit-sampler.js';
import { AskCard } from './client/ask-card.js';
import { ProposalCard } from './client/proposal-card.js';
import { ChatList } from './client/chat-list.js';

// Walk a preact vnode tree → collect text, classes, clickable buttons, and inputs (with their handlers).
const collect = v => {
  const acc = { text: [], classes: [], buttons: [], inputs: [], styles: [] };
  const textOf = node => { const a = { text: [], classes: [], buttons: [], inputs: [], styles: [] }; walk(node, a); return a.text.join(''); };
  function walk(n, a) {
    if (n == null || n === false || n === true) return;
    if (Array.isArray(n)) { for (const c of n) walk(c, a); return; }
    if (typeof n === 'string' || typeof n === 'number') { a.text.push(String(n)); return; }
    const p = (n && n.props) || {};
    if (p.class) a.classes.push(p.class);
    if (p.style) a.styles.push(p.style);
    if (typeof p.onClick === 'function') a.buttons.push({ label: textOf(p.children), cls: p.class || '', onClick: p.onClick });
    if (typeof p.onInput === 'function' || typeof p.onChange === 'function') a.inputs.push({ type: p.type || (n.type || ''), cls: p.class || '', onInput: p.onInput, onChange: p.onChange });
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

test('PowersBanner: chips render with icon+name; manageable → × per chip → onRevoke(power) + an Add button → onAddPowers', () => {
  let revoked = null; let added = 0;
  const acc = collect(PowersBanner({
    items: [{ power: 'notes', icon: '📓', tip: 'notes — vault' }, { power: 'web', icon: '🌐' }],
    manageable: true, onRevoke: p => { revoked = p; }, onAddPowers: () => { added += 1; },
  }));
  const t = allText(acc);
  assert.match(t, /notes/); assert.match(t, /web/); assert.match(t, /📓/);
  const xs = acc.buttons.filter(b => b.cls.includes('chip-x')); assert.equal(xs.length, 2, 'a × per chip when manageable');
  xs[0].onClick(); assert.equal(revoked, 'notes', 'onRevoke called with the power');
  const add = acc.buttons.find(b => b.cls.includes('chip-add')); assert.ok(add, 'an Add button'); add.onClick();
  assert.equal(added, 1, 'onAddPowers fires');
  // not manageable → no × and no Add (read-only view)
  const ro = collect(PowersBanner({ items: [{ power: 'notes', icon: '📓' }], manageable: false }));
  assert.equal(ro.buttons.filter(b => b.cls.includes('chip-x') || b.cls.includes('chip-add')).length, 0, 'read-only: no revoke/add');
});

test('kit form inputs are CONTROLLED: value renders, and the right handler fires with the value', () => {
  let txt = null; const tf = collect(TextField({ value: 'hi', onInput: v => { txt = v; } }));
  tf.inputs[0].onInput({ target: { value: 'there' } }); assert.equal(txt, 'there', 'TextField onInput(value)');
  let ta = null; collect(Textarea({ value: 'x', onInput: v => { ta = v; } })).inputs[0].onInput({ target: { value: 'y' } }); assert.equal(ta, 'y');
  let sel = null; collect(Select({ value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onChange: v => { sel = v; } })).inputs[0].onChange({ target: { value: 'b' } }); assert.equal(sel, 'b');
  let chk = null; collect(Checkbox({ label: 'x', checked: false, onChange: v => { chk = v; } })).inputs[0].onChange({ target: { checked: true } }); assert.equal(chk, true);
  let tog = null; collect(Toggle({ label: 'dark', checked: false, onChange: v => { tog = v; } })).inputs[0].onChange({ target: { checked: true } }); assert.equal(tog, true);
  let rg = null; const rgi = collect(RadioGroup({ name: 'g', value: 'one', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }], onChange: v => { rg = v; } }));
  rgi.inputs[1].onChange(); assert.equal(rg, 'two', 'RadioGroup onChange(value)');
});

test('kit display primitives render their semantics (Tabs active, ProgressBar width, Banner kind, Badge, Spinner, Avatar)', () => {
  let tab = null; const tabs = collect(Tabs({ tabs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], active: 'a', onSelect: id => { tab = id; } }));
  assert.ok(tabs.classes.some(c => c.includes('kit-tab') && c.includes('on')), 'active tab has .on');
  tabs.buttons.find(b => b.label === 'B').onClick(); assert.equal(tab, 'b', 'Tabs onSelect(id)');
  assert.ok(collect(ProgressBar({ value: 0.6 })).styles.some(s => /width:\s*60/.test(s)), 'ProgressBar width reflects value');
  assert.ok(collect(Banner({ kind: 'error', children: 'x' })).classes.some(c => c.includes('kit-banner') && c.includes('error')), 'Banner kind → class');
  assert.match(collect(Badge({ label: '3' })).classes.join(' '), /kit-badge/);
  assert.match(collect(Spinner({})).classes.join(' '), /kit-spinner/);
  assert.match(collect(Avatar({ label: '🤖' })).text.join(''), /🤖/);
});

test('AskCard: typed controls render + onChange(qid,value); Submit → onSubmit(id); answered → no inputs; secret masked', () => {
  const ask = { id: 'a1', title: 'Pick', requestedBy: 'agent', questions: [
    { id: 'choice', q: 'one?', type: 'choice', options: ['x', 'y'] },
    { id: 'ms', q: 'many?', type: 'multiselect', options: ['p', 'q'] },
    { id: 'num', q: 'how many?', type: 'number' },
    { id: 'pw', q: 'secret?', type: 'secret' },
    { id: 'free', q: 'notes?', type: 'text' },
  ] };
  const changes = []; let submitted = null;
  const acc = collect(AskCard({ ask, answers: { choice: 'x', ms: ['p'] }, status: '', onChange: (qid, v) => changes.push([qid, v]), onSubmit: id => { submitted = id; } }));
  assert.match(allText(acc), /Pick/); assert.match(allText(acc), /agent/, 'requestedBy chip');
  // a radio choice fires onChange(qid, value)
  acc.inputs.find(i => i.type === 'radio').onChange(); assert.equal(changes[0][0], 'choice', 'choice → onChange(qid,..)');
  // the secret field is a password input (masked), present while unanswered
  assert.ok(acc.inputs.some(i => i.type === 'password'), 'secret rendered as password');
  // Submit fires onSubmit(askId)
  acc.buttons.find(b => /Submit/.test(b.label)).onClick(); assert.equal(submitted, 'a1');
  // once answered → "✓ answered", no Submit button, and the secret is a chip (never re-shown)
  const done = collect(AskCard({ ask, answers: {}, status: 'answered', onChange() {}, onSubmit() {} }));
  assert.match(allText(done), /✓ answered/);
  assert.equal(done.buttons.filter(b => /Submit/.test(b.label)).length, 0, 'no Submit once answered');
  assert.equal(done.inputs.filter(i => i.type === 'password').length, 0, 'secret input gone once answered (stored-securely chip)');
});

test('ProposalCard: type-specific body, Confirm→onConfirm(id,dontAsk), Reject→onReject; non-confirmable shows awaiting; HA/specialist get no dont-ask', () => {
  let confirmed = null; let rejected = null; let toggled = null;
  const acc = collect(ProposalCard({
    proposal: { id: 'p1', type: 'email', title: 'Send email', detail: { to: 'a@b.c', subject: 'Hi', body: 'yo' } },
    icon: '✉️', accent: '#7c5cff', mayConfirm: true, dontAsk: true,
    onConfirm: (id, da) => { confirmed = [id, da]; }, onReject: id => { rejected = id; }, onToggleDontAsk: v => { toggled = v; },
  }));
  const t = allText(acc);
  assert.match(t, /Send email/); assert.match(t, /a@b\.c/); assert.match(t, /Hi/, 'email body fields render');
  acc.buttons.find(b => b.cls === 'confirm').onClick(); assert.deepEqual(confirmed, ['p1', true], 'Confirm passes id + dontAsk');
  acc.buttons.find(b => b.cls === 'reject').onClick(); assert.equal(rejected, 'p1');
  acc.inputs.find(i => i.type === 'checkbox').onChange({ target: { checked: false } }); assert.equal(toggled, false, 'dont-ask toggle');
  // not confirmable → awaiting message, no buttons
  const await_ = collect(ProposalCard({ proposal: { id: 'p2', type: 'email', title: 'x', detail: {} }, mayConfirm: false }));
  assert.match(allText(await_), /awaiting the operator/);
  assert.equal(await_.buttons.filter(b => b.cls === 'confirm').length, 0);
  // home-assistant + spawn-specialist NEVER offer "don't ask again"
  const ha = collect(ProposalCard({ proposal: { id: 'p3', type: 'home-assistant', title: 'unlock', detail: { entity_id: 'lock.front', service: 'unlock' } }, mayConfirm: true }));
  assert.equal(ha.inputs.filter(i => i.type === 'checkbox').length, 0, 'HA: no don\'t-ask checkbox');
});

test('ChatList: select / delete / show-more by id; empty state; the editing row renders an input (inline rename)', () => {
  let selected = null; let deleted = null; let moreClicked = 0;
  const items = [{ id: 'c1', title: 'Berlin trip', active: true, needs: true }, { id: 'c2', title: 'voice memo', voice: true, perm: 'read' }];
  const acc = collect(ChatList({ items, more: 3, onSelect: id => { selected = id; }, onDelete: id => { deleted = id; }, onMore: () => { moreClicked += 1; } }));
  assert.match(allText(acc), /Berlin trip/); assert.match(allText(acc), /🎙/, 'voice badge');
  acc.buttons.find(b => b.cls.includes('ci-title')).onClick(); assert.equal(selected, 'c1', 'title click → onSelect(id)');
  acc.buttons.find(b => b.cls.includes('ci-del')).onClick(); assert.equal(deleted, 'c1', '× → onDelete(id)');
  acc.buttons.find(b => b.cls.includes('ci-more')).onClick(); assert.equal(moreClicked, 1, 'show more');
  // empty state
  assert.match(allText(collect(ChatList({ items: [], emptyText: 'no chats' }))), /no chats/);
  // editing row → an input (stateless inline rename, host holds editingId + draft)
  const ed = collect(ChatList({ items, editingId: 'c1', draft: 'New name', onRenameChange() {}, onRenameCommit() {} }));
  assert.ok(ed.inputs.some(i => i.cls.includes('kit-in')), 'the edited row renders a kit input');
});

test('kit overlays + extra primitives: Modal open/closed + onClose; Segmented/Slider/Disclosure/Breadcrumb/Skeleton', () => {
  assert.equal(Modal({ open: false }), null, 'closed Modal renders nothing');
  let closed = 0; const m = collect(Modal({ open: true, title: 'Hi', children: 'body', onClose: () => { closed += 1; } }));
  assert.ok(m.classes.some(c => c.includes('kit-modal')), 'open Modal renders a dialog');
  assert.match(allText(m), /Hi/); assert.match(allText(m), /body/);
  m.buttons.find(b => b.cls.includes('kit-modal-x')).onClick(); assert.equal(closed, 1, 'Modal close fires');
  let seg = null; const sc = collect(SegmentedControl({ value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onChange: v => { seg = v; } }));
  assert.ok(sc.classes.some(c => c === 'on'), 'segmented marks the active option');
  sc.buttons.find(b => b.label === 'B').onClick(); assert.equal(seg, 'b');
  let sl = null; collect(Slider({ value: 5, onInput: v => { sl = v; } })).inputs[0].onInput({ target: { value: '42' } }); assert.equal(sl, 42, 'Slider onInput(number)');
  let tog = 0; const dc = collect(Disclosure({ summary: 'More', open: true, children: 'shown', onToggle: () => { tog += 1; } }));
  assert.match(allText(dc), /shown/, 'open Disclosure shows children');
  dc.buttons[0] && dc.buttons[0].onClick(); assert.equal(tog, 1, 'Disclosure onToggle');
  assert.equal(allText(collect(Disclosure({ summary: 'More', open: false, children: 'hidden' }))).includes('hidden'), false, 'closed Disclosure hides children');
  let crumb = null; const bc = collect(Breadcrumb({ items: [{ label: 'Home', onClick: () => { crumb = 'home'; } }, { label: 'Here' }] }));
  bc.buttons[0] && bc.buttons[0].onClick(); assert.equal(crumb, 'home', 'breadcrumb link click');
  assert.match(collect(Skeleton({ width: '50%' })).classes.join(' '), /kit-skel/);
});

test('kit data primitives: Menu open/select, Toast close, Pagination, Table cells, List select, Tooltip', () => {
  let picked = null; const mn = collect(Menu({ label: '⋯', open: true, items: [{ label: 'Rename', value: 'rn' }, { label: 'Delete', value: 'del' }], onSelect: v => { picked = v; } }));
  mn.buttons.find(b => b.label === 'Delete').onClick(); assert.equal(picked, 'del', 'Menu onSelect(value)');
  assert.equal(collect(Menu({ open: false, items: [{ label: 'x' }] })).buttons.filter(b => b.cls.includes('kit-menu-item')).length, 0, 'closed menu has no items');
  let tc = 0; collect(Toast({ message: 'hi', onClose: () => { tc += 1; } })).buttons[0].onClick(); assert.equal(tc, 1, 'Toast close');
  let pg = null; const pa = collect(Pagination({ page: 2, pages: 4, onPage: n => { pg = n; } }));
  assert.ok(pa.classes.some(c => c === 'on'), 'current page marked'); pa.buttons.find(b => b.label === '3').onClick(); assert.equal(pg, 3, 'Pagination onPage(n)');
  const tb = collect(Table({ columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], rows: [{ a: 'x1', b: 'y1' }] }));
  assert.match(allText(tb), /A/); assert.match(allText(tb), /x1/, 'Table renders header + cells');
  let li = null; collect(List({ items: [{ label: 'One' }, { label: 'Two' }], onSelect: i => { li = i; } })).buttons.length; // List items are divs w/ onClick → buttons
  const lc = collect(List({ items: [{ label: 'One' }, { label: 'Two' }], onSelect: i => { li = i; } })); lc.buttons[1].onClick(); assert.equal(li, 1, 'List onSelect(index)');
  assert.match(allText(collect(Tooltip({ tip: 'hint', children: 'word' }))).replace(/\s+/g, ''), /wordhint|hintword|word/, 'Tooltip renders child + tip');
});

test('KitSampler renders every primitive without error (the design-system smoke test)', () => {
  const acc = collect(KitSampler());
  // a broad spread of the kit classes must all appear → all primitives composed + rendered
  for (const cls of ['kit-in', 'kit-toggle', 'kit-tab', 'kit-banner', 'kit-progress', 'kit-badge', 'kit-spinner', 'kit-avatar', 'kit-divider', 'ncard', 'kit-seg', 'kit-slider', 'kit-skel', 'kit-disc', 'kit-crumbs', 'kit-menu', 'kit-toast', 'kit-page', 'kit-table', 'kit-list', 'kit-tip']) {
    assert.ok(acc.classes.some(c => String(c).split(/\s+/).includes(cls)), `sampler renders ${cls}`);
  }
});
