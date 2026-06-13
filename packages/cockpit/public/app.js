// Garden Cockpit frontend — a boring, no-build websocket client.
// Doer Mode: thread tree, per-thread streaming transcript, steer.

const $ = id => document.getElementById(id);
const ws = new WebSocket(`ws://${location.host}/ws`);

let threadsFlat = [];
let selected = null;
const transcripts = {}; // threadId -> [events]

ws.onopen = () => {
  $('status').textContent = 'connected';
  ws.send(JSON.stringify({ type: 'hello' }));
};
ws.onclose = () => {
  $('status').textContent = 'disconnected';
};
ws.onmessage = ev => handle(JSON.parse(ev.data));

function handle(m) {
  if (m.type === 'threads') {
    threadsFlat = flatten(m.tree, 0);
    renderThreadList();
    if (!selected && threadsFlat[0]) select(threadsFlat[0].id);
    else if (selected) renderSidebar();
  } else if (m.type === 'thread-event') {
    (transcripts[m.threadId] ||= []).push(m.event);
    if (m.threadId === selected) appendEvent(m.event);
  } else if (m.type === 'error') {
    appendLine(`⚠ ${m.message}`, 'err');
  }
}

function flatten(tree, depth) {
  const out = [];
  for (const node of tree) {
    out.push({ ...node, depth });
    out.push(...flatten(node.children || [], depth + 1));
  }
  return out;
}

function renderThreadList() {
  const ul = $('thread-list');
  ul.innerHTML = '';
  for (const t of threadsFlat) {
    const li = document.createElement('li');
    li.style.paddingLeft = `${8 + t.depth * 16}px`;
    li.className = t.id === selected ? 'selected' : '';
    li.innerHTML =
      `<span class="dot ${t.status}"></span>` +
      `<b>${t.id}</b> <span class="tpl">${t.templateName}</span>` +
      `<span class="capcount">${t.caps.length} caps</span>`;
    li.onclick = () => select(t.id);
    ul.appendChild(li);
  }
}

function select(id) {
  selected = id;
  const t = threadsFlat.find(x => x.id === id);
  $('pane-title').textContent = t ? `${t.id} · ${t.templateName} · ${t.status}` : id;
  const box = $('transcript');
  box.innerHTML = '';
  for (const ev of transcripts[id] || []) appendEvent(ev);
  renderThreadList();
  renderSidebar();
}

let streamLine = null;
function appendEvent(ev) {
  if (ev.kind === 'token') {
    if (!streamLine) {
      streamLine = document.createElement('div');
      streamLine.className = 'line tok';
      $('transcript').appendChild(streamLine);
    }
    streamLine.textContent += ev.token;
    scroll();
    return;
  }
  streamLine = null;
  const label = {
    'turn-start': '» ',
    'tool-call': '⚙ ',
    'tool-result': '→ ',
    spawn: '⑂ ',
    error: '⚠ ',
    'turn-end': '─',
  }[ev.kind] || '';
  if (ev.kind === 'turn-end') return appendLine('─────', 'sep');
  const text = ev.message || (typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data));
  appendLine(label + text, ev.kind);
}

function appendLine(text, cls = '') {
  const div = document.createElement('div');
  div.className = `line ${cls}`;
  div.textContent = text;
  $('transcript').appendChild(div);
  scroll();
}
function scroll() {
  const box = $('transcript');
  box.scrollTop = box.scrollHeight;
}

function renderSidebar() {
  const t = threadsFlat.find(x => x.id === selected);
  const caps = $('caps');
  const o11y = $('o11y');
  if (!t) {
    caps.innerHTML = '';
    o11y.innerHTML = '';
    return;
  }
  caps.innerHTML = '';
  if (!t.caps.length) {
    caps.insertAdjacentHTML('beforeend', '<div class="cap muted">no capabilities</div>');
  }
  for (const c of t.caps) {
    const row = document.createElement('div');
    row.className = 'cap';
    row.innerHTML = `${c.name} <em>${c.kind}</em> <b>${c.mode || '—'}</b>`;
    const btn = document.createElement('button');
    btn.textContent = 'revoke';
    btn.onclick = () =>
      ws.send(JSON.stringify({ type: 'revoke-cap', threadId: t.id, capName: c.name }));
    row.appendChild(btn);
    caps.appendChild(row);
  }
  // M2: grant a fresh cap into the thread's scope.
  const grant = document.createElement('div');
  grant.className = 'grant';
  grant.innerHTML =
    '<select id="g-kind"><option>git</option><option>workspace</option></select>' +
    '<select id="g-mode"><option>readWrite</option><option>readOnly</option></select>' +
    '<button id="g-btn">+ grant</button>';
  caps.appendChild(grant);
  $('g-btn').onclick = () => {
    const kind = $('g-kind').value;
    ws.send(
      JSON.stringify({
        type: 'grant-cap',
        threadId: t.id,
        cap: { name: kind, kind, mode: $('g-mode').value },
      }),
    );
  };
  o11y.innerHTML =
    `<div>tokens: ${t.o11y.tokens}</div>` +
    `<div>turns: ${t.o11y.turns}</div>` +
    `<div>engine: ${t.engineKind}</div>`;
}

$('steer-form').onsubmit = e => {
  e.preventDefault();
  const input = $('steer-input');
  const text = input.value.trim();
  if (!text || !selected) return;
  ws.send(JSON.stringify({ type: 'steer', threadId: selected, text }));
  input.value = '';
};

// M2: the new-thread form. With a parent id it spawns via delegation; without,
// it creates a root thread. Caps are chosen by checkbox + mode.
$('new-thread-btn').onclick = () => $('new-thread-dialog').showModal();
$('new-thread-form').addEventListener('submit', e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  const f = e.target;
  const caps = [];
  if (f.git.checked) caps.push({ name: 'git', kind: 'git', mode: f.gitMode.value });
  if (f.workspace.checked)
    caps.push({ name: 'workspace', kind: 'workspace', mode: f.workspaceMode.value });
  const parentId = f.parentId.value.trim();
  const prompt = f.prompt.value;
  const templateName = f.templateName.value || (parentId ? 'delegate' : 'adhoc');
  ws.send(
    JSON.stringify(
      parentId
        ? { type: 'spawn', parentId, templateName, caps, prompt }
        : { type: 'new-thread', templateName, caps, prompt },
    ),
  );
});

// M1: spawn a child thread via delegation, handing it a read-only subset of the
// selected thread's caps (attenuation by selection; the harness enforces it).
function spawnChild() {
  const t = threadsFlat.find(x => x.id === selected);
  if (!t) return;
  const task = window.prompt(`spawn a child of ${t.id} (read-only subset of its caps). task:`, 'inspect the repo');
  if (task === null) return;
  const caps = t.caps.map(c => ({
    name: c.name,
    kind: c.kind,
    mode: c.mode === 'readWrite' ? 'readOnly' : c.mode,
  }));
  ws.send(JSON.stringify({ type: 'spawn', parentId: t.id, templateName: 'delegate', caps, prompt: task }));
}

const spawnBtn = document.createElement('button');
spawnBtn.id = 'spawn-btn';
spawnBtn.textContent = '⑂ spawn child';
spawnBtn.onclick = spawnChild;
$('pane-title').after(spawnBtn);
