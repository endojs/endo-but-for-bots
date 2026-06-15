// Garden Cockpit frontend — a boring, no-build websocket client.
// Doer Mode: thread tree, per-thread streaming transcript, steer.

const $ = id => document.getElementById(id);
const ws = new WebSocket(`ws://${location.host}/ws`);

let threadsFlat = [];
let selected = null;
let mode = 'doer';
let templates = [];
let o11ySummary = null;
let daemonOnline = false;
let profiles = []; // masked: { name, provider, baseUrl }
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
  } else if (m.type === 'templates') {
    templates = m.list;
    if (mode === 'builder') renderBuilder();
  } else if (m.type === 'o11y') {
    o11ySummary = m.summary;
    renderGlobalO11y();
  } else if (m.type === 'steward') {
    if (mode === 'steward') renderSteward(m.view);
  } else if (m.type === 'daemon') {
    daemonOnline = !!m.online;
    renderDaemon(m.sockPath);
    syncAgentryFields();
  } else if (m.type === 'profiles') {
    profiles = m.list || [];
    renderProfileOptions();
    if (mode === 'builder') renderBuilder();
  } else if (m.type === 'transcript') {
    showTranscript(m.markdown);
  } else if (m.type === 'error') {
    appendLine(`⚠ ${m.message}`, 'error');
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
  $('pane-title').textContent = t
    ? `${t.id} · ${t.templateName} · ${t.status}`
    : id;
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
  const label =
    {
      'turn-start': '» ',
      'tool-call': '⚙ ',
      'tool-result': '→ ',
      spawn: '⑂ ',
      error: '⚠ ',
      'turn-end': '─',
    }[ev.kind] || '';
  if (ev.kind === 'turn-end') return appendLine('─────', 'sep');
  const text =
    ev.message ||
    (typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data));
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
    caps.insertAdjacentHTML(
      'beforeend',
      '<div class="cap muted">no capabilities</div>',
    );
  }
  for (const c of t.caps) {
    const row = document.createElement('div');
    row.className = 'cap';
    row.innerHTML = `${c.name} <em>${c.kind}</em> <b>${c.mode || '—'}</b>`;
    const btn = document.createElement('button');
    btn.textContent = 'revoke';
    btn.onclick = () =>
      ws.send(
        JSON.stringify({ type: 'revoke-cap', threadId: t.id, capName: c.name }),
      );
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
$('new-thread-btn').onclick = () => {
  syncAgentryFields();
  $('new-thread-dialog').showModal();
};
$('new-thread-form').addEventListener('submit', e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  const f = e.target;
  const caps = [];
  if (f.git.checked)
    caps.push({ name: 'git', kind: 'git', mode: f.gitMode.value });
  if (f.workspace.checked)
    caps.push({
      name: 'workspace',
      kind: 'workspace',
      mode: f.workspaceMode.value,
    });
  const parentId = f.parentId.value.trim();
  const prompt = f.prompt.value;
  const templateName =
    f.templateName.value || (parentId ? 'delegate' : 'adhoc');
  // When the daemon is online and a profile is chosen, build a real agentry
  // thread; otherwise the mock path. The agentry fields are inert offline.
  const profileName = daemonOnline ? f.profileName.value || '' : '';
  const agentry = profileName
    ? {
        profileName,
        model: f.model.value || '',
        workspacePetName: f.workspacePetName.value || undefined,
        gitPetName: f.gitPetName.value || undefined,
        gitMode: f.agentryGitMode.value || undefined,
      }
    : {};
  ws.send(
    JSON.stringify(
      parentId
        ? { type: 'spawn', parentId, templateName, caps, prompt, ...agentry }
        : { type: 'new-thread', templateName, caps, prompt, ...agentry },
    ),
  );
});

// M1: spawn a child thread via delegation, handing it a read-only subset of the
// selected thread's caps (attenuation by selection; the harness enforces it).
function spawnChild() {
  const t = threadsFlat.find(x => x.id === selected);
  if (!t) return;
  const task = window.prompt(
    `spawn a child of ${t.id} (read-only subset of its caps). task:`,
    'inspect the repo',
  );
  if (task === null) return;
  const caps = t.caps.map(c => ({
    name: c.name,
    kind: c.kind,
    mode: c.mode === 'readWrite' ? 'readOnly' : c.mode,
  }));
  ws.send(
    JSON.stringify({
      type: 'spawn',
      parentId: t.id,
      templateName: 'delegate',
      caps,
      prompt: task,
    }),
  );
}

const spawnBtn = document.createElement('button');
spawnBtn.id = 'spawn-btn';
spawnBtn.textContent = '⑂ spawn child';
spawnBtn.onclick = spawnChild;
$('pane-title').after(spawnBtn);

// M3: export the selected thread's transcript as a journal entry.
const exportBtn = document.createElement('button');
exportBtn.id = 'export-btn';
exportBtn.textContent = '⇩ export';
exportBtn.onclick = () =>
  selected &&
  ws.send(JSON.stringify({ type: 'export-thread', threadId: selected }));
spawnBtn.after(exportBtn);

// M3: Doer / Builder / Steward planes.
const builderPanel = document.createElement('div');
builderPanel.id = 'builder-panel';
const stewardPanel = document.createElement('div');
stewardPanel.id = 'steward-panel';
$('center').append(builderPanel, stewardPanel);

document.querySelectorAll('#modes button').forEach(b => {
  b.onclick = () => setMode(b.dataset.mode);
});

function setMode(m) {
  mode = m;
  const doer = m === 'doer';
  document
    .querySelectorAll('#modes button')
    .forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  for (const el of [$('transcript'), $('steer-form'), spawnBtn, exportBtn]) {
    el.style.display = doer ? '' : 'none';
  }
  builderPanel.style.display = m === 'builder' ? '' : 'none';
  stewardPanel.style.display = m === 'steward' ? '' : 'none';
  if (doer) {
    $('pane-title').textContent = selected || 'select a thread';
  } else {
    $('pane-title').textContent = `${m} mode`;
  }
  if (m === 'builder') renderBuilder();
  if (m === 'steward') ws.send(JSON.stringify({ type: 'steward' }));
}

// Header daemon indicator.
function renderDaemon(sockPath) {
  const el = $('daemon');
  if (!el) return;
  el.className = `daemon ${daemonOnline ? 'online' : 'offline'}`;
  el.textContent = daemonOnline ? '● online' : '● offline';
  el.title = daemonOnline
    ? `daemon online${sockPath ? ` — ${sockPath}` : ''}`
    : 'no daemon — running on the mock engine (OFFLINE)';
}

// Enable the agentry new-thread fields only when a daemon is online.
function syncAgentryFields() {
  const fs = $('agentry-fields');
  if (fs) fs.disabled = !daemonOnline;
}

// Populate the new-thread provider-profile <select> with the masked profiles.
function renderProfileOptions() {
  const sel = document.querySelector(
    '#new-thread-form select[name=profileName]',
  );
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— mock engine —</option>';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = `${p.name} (${p.provider})`;
    sel.appendChild(opt);
  }
  sel.value = current;
}

// Builder Mode — Provider profiles section. Resets the panel, then lists the
// MASKED profiles (name / provider / baseUrl only — the apiKey never reaches
// the UI) and offers an add form. Profiles need a daemon (they live in the
// petstore), so the add form is gated on daemonOnline.
function renderProviderProfiles() {
  builderPanel.innerHTML = '<h2>Provider profiles</h2>';
  if (!daemonOnline) {
    builderPanel.insertAdjacentHTML(
      'beforeend',
      '<p class="muted">offline — connect a daemon to store provider profiles</p>',
    );
    return;
  }
  if (!profiles.length) {
    builderPanel.insertAdjacentHTML(
      'beforeend',
      '<p class="muted">no profiles yet</p>',
    );
  }
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'tpl-row';
    row.innerHTML =
      `<b>${p.name}</b> <span class="muted">${p.provider}</span> ` +
      `<span class="muted">${p.baseUrl || ''}</span>`;
    builderPanel.appendChild(row);
  }
  const add = document.createElement('div');
  add.className = 'grant';
  add.innerHTML =
    '<input id="pf-name" placeholder="name" />' +
    '<input id="pf-provider" placeholder="provider" />' +
    '<input id="pf-apikey" type="password" placeholder="api key" />' +
    '<input id="pf-baseurl" placeholder="base url (optional)" />' +
    '<button id="pf-add">+ add profile</button>';
  builderPanel.appendChild(add);
  $('pf-add').onclick = () => {
    const name = $('pf-name').value.trim();
    const provider = $('pf-provider').value.trim();
    const apiKey = $('pf-apikey').value;
    const baseUrl = $('pf-baseurl').value.trim();
    if (!name || !provider || !apiKey) return;
    ws.send(
      JSON.stringify({
        type: 'define-profile',
        name,
        provider,
        apiKey,
        baseUrl: baseUrl || undefined,
      }),
    );
    $('pf-name').value = '';
    $('pf-provider').value = '';
    $('pf-apikey').value = '';
    $('pf-baseurl').value = '';
  };
}

// Builder Mode (the define plane): author templates + provider profiles.
function renderBuilder() {
  renderProviderProfiles();
  builderPanel.insertAdjacentHTML('beforeend', '<h2>Templates</h2>');
  for (const t of templates) {
    const row = document.createElement('div');
    row.className = 'tpl-row';
    const shape =
      t.capShape.map(c => `${c.name}:${c.mode || '—'}`).join(', ') || 'no caps';
    row.innerHTML = `<b>${t.name}</b> <span class="muted">${shape}</span> <span class="muted">${t.model}</span>`;
    const use = document.createElement('button');
    use.textContent = 'use';
    use.onclick = () => useTemplate(t);
    const del = document.createElement('button');
    del.textContent = 'delete';
    del.onclick = () =>
      ws.send(JSON.stringify({ type: 'delete-template', name: t.name }));
    row.append(use, del);
    builderPanel.appendChild(row);
  }
  const add = document.createElement('button');
  add.textContent = '+ new template';
  add.onclick = () => $('builder-dialog').showModal();
  builderPanel.appendChild(add);
}

function useTemplate(t) {
  const task = window.prompt(`task for a ${t.name} thread:`, t.prompt);
  if (task === null) return;
  ws.send(
    JSON.stringify({
      type: 'new-thread',
      templateName: t.name,
      caps: t.capShape,
      prompt: task,
    }),
  );
  setMode('doer');
}

$('builder-form').addEventListener('submit', e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  const f = e.target;
  const capShape = (f.capShape.value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [name, kind, mode_] = s.split(':').map(x => x.trim());
      return { name, kind: kind || name, mode: mode_ };
    });
  ws.send(
    JSON.stringify({
      type: 'define-template',
      template: {
        name: f.name.value,
        prompt: f.prompt.value,
        capShape,
        model: f.model.value,
      },
    }),
  );
});

// Steward Mode: the autonomous-loop projection.
function renderSteward(v) {
  const loop = v.autonomousLoop;
  stewardPanel.innerHTML =
    '<h2>Autonomous loop</h2>' +
    `<div>posture: ${loop.posture}</div>` +
    `<div>status: ${loop.status}</div>` +
    `<div>running: ${loop.runningThreads} / ${loop.totalThreads}</div>` +
    '<h2>Feed</h2>' +
    v.feed.map(line => `<div class="feed">${line}</div>`).join('');
}

// Global observability.
const globalO11y = document.createElement('div');
globalO11y.id = 'global-o11y';
$('side-pane').appendChild(globalO11y);
function renderGlobalO11y() {
  if (!o11ySummary) return;
  const t = o11ySummary.total;
  globalO11y.innerHTML =
    '<h2>Totals</h2>' +
    `<div>threads: ${t.threads}</div>` +
    `<div>tokens: ${t.tokens}</div>` +
    `<div>turns: ${t.turns}</div>`;
}

function showTranscript(md) {
  let d = $('transcript-dialog');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'transcript-dialog';
    d.innerHTML =
      '<pre id="transcript-md"></pre><menu><button id="tx-close">close</button></menu>';
    document.body.appendChild(d);
    d.querySelector('#tx-close').onclick = () => d.close();
  }
  d.querySelector('#transcript-md').textContent = md;
  d.showModal();
}
