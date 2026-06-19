// homeassistant-trie.mjs — a general-purpose HomeAssistant → object-capability
// generator. Run it once and you get an OBJECT TRIE of the whole instance:
//
//     root ──rooms──▶ Room ──types──▶ Type(domain) ──entities──▶ Entity
//
// The point is ocap correctness. Authority is the OBJECT you hold, never a
// string the server re-resolves against its ambient (full-HA) token — that
// string-designation is exactly the Confused Deputy (Hardy) / "designation must
// be authorization" failure that capabilities exist to prevent (Close, *Capability
// Myths Demolished*). So:
//   • You navigate by holding a node and calling a getter for a CHILD object.
//   • `readOnly()` is the standard read facet on ANY node; it attenuates
//     RECURSIVELY — a read-only Room's getters return read-only Types whose
//     getters return read-only Entities (no actions anywhere below).
//   • Every node has an unguessable HANDLE (a web-key). Over a string transport
//     (the LLM's JSON tool calls, the browser's /rpc) you designate a node by its
//     handle, which you can only have learned by navigating a node you already
//     hold. You cannot forge a handle to something you weren't given.
//   • An Entity's actions don't fire — they create a confirmable PROPOSAL whose
//     commit closure captures THIS entity's own actuator (object-designated). The
//     entity_id lives only inside that closure, built from HA's own registry data,
//     never re-interpreted from agent/holder input.
import '@endo/init';
import crypto from 'node:crypto';
import { Far } from '@endo/marshal';

const newHandle = () => crypto.randomBytes(8).toString('hex');

// HA's own default "agents" + Assist voice pipeline. We expose the SAME devices
// through a superior object-capability navigator, so these competing agent
// surfaces are distractions — excluded from the inventory. Override via
// HA_EXCLUDE_DOMAINS (comma-separated) if needed.
const DEFAULT_EXCLUDE = ['conversation', 'stt', 'tts', 'ai_task', 'assist_satellite', 'wake_word', 'assist_pipeline'];
const EXCLUDE_DOMAINS = new Set((process.env.HA_EXCLUDE_DOMAINS ? process.env.HA_EXCLUDE_DOMAINS.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_EXCLUDE));

// services we expose per domain (verb selectors — the TARGET is always the held
// object, so naming the verb by string is fine; it's a method name, not a designation).
const DOMAIN_ACTIONS = harden({
  light: ['turn_on', 'turn_off', 'toggle'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle'],
  input_boolean: ['turn_on', 'turn_off', 'toggle'],
  lock: ['lock', 'unlock', 'open'],
  cover: ['open_cover', 'close_cover', 'stop_cover', 'toggle'],
  climate: ['turn_on', 'turn_off', 'set_temperature'],
  media_player: ['media_play', 'media_pause', 'media_stop', 'volume_up', 'volume_down'],
  scene: ['turn_on'],
  script: ['turn_on'],
  button: ['press'],
  vacuum: ['start', 'pause', 'stop', 'return_to_base'],
});

// One-shot WebSocket fetch of the area/device/entity registries (REST doesn't
// expose them). Returns { areas, entities, devices } or null on failure.
const wsRegistries = (wsUrl, token) => new Promise(resolve => {
  let ws;
  try { ws = new WebSocket(wsUrl); } catch { return resolve(null); }
  let id = 1; const pending = new Map(); const out = {};
  const send = msg => { const i = id++; ws.send(JSON.stringify({ id: i, ...msg })); return new Promise(r => pending.set(i, r)); };
  const to = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 12000);
  ws.onmessage = async ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'auth_required') { ws.send(JSON.stringify({ type: 'auth', access_token: token })); return; }
    if (m.type === 'auth_ok') {
      try {
        out.areas = (await send({ type: 'config/area_registry/list' })).result || [];
        out.entities = (await send({ type: 'config/entity_registry/list' })).result || [];
        out.devices = (await send({ type: 'config/device_registry/list' })).result || [];
      } catch { clearTimeout(to); try { ws.close(); } catch {} return resolve(null); }
      clearTimeout(to); try { ws.close(); } catch {} resolve(out);
      return;
    }
    if (m.type === 'auth_invalid') { clearTimeout(to); try { ws.close(); } catch {} resolve(null); return; }
    if (m.type === 'result') { const r = pending.get(m.id); if (r) r(m); }
  };
  ws.onerror = () => { clearTimeout(to); resolve(null); };
});

// makeHaTrie({ baseUrl, token, propose }) → async →
//   { root, nodeByHandle, configured, roomCount, entityCount } | { configured:false, error }
// `propose` is the field-agent's proposal registrar; entity actions call it so
// every actuation stays a confirmable proposal.
export const makeHaTrie = async ({ baseUrl, token, propose }) => {
  const REST = baseUrl.replace(/\/$/, '');
  const WS = `${REST.replace(/^http/, 'ws')}/api/websocket`;
  const auth = { authorization: `Bearer ${token}` };

  let states;
  try {
    const r = await fetch(`${REST}/api/states`, { headers: auth, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return harden({ configured: false, error: `HA ${r.status}` });
    states = await r.json();
  } catch (e) { return harden({ configured: false, error: e.message }); }

  // entity_id → room name, via entity.area_id ?? device(area_id).
  const reg = await wsRegistries(WS, token);
  const roomOf = new Map();
  if (reg) {
    const areaName = Object.fromEntries(reg.areas.map(a => [a.area_id, a.name]));
    const devArea = Object.fromEntries(reg.devices.map(d => [d.id, d.area_id]));
    for (const e of reg.entities) {
      const aid = e.area_id || (e.device_id && devArea[e.device_id]);
      if (aid && areaName[aid]) roomOf.set(e.entity_id, areaName[aid]);
    }
  }
  const UNASSIGNED = 'Unassigned';

  // rooms: Map(roomName → Map(domain → [ {entity_id, name, state} ]))
  const rooms = new Map();
  let excluded = 0;
  for (const e of states) {
    const domain = e.entity_id.split('.')[0];
    if (EXCLUDE_DOMAINS.has(domain)) { excluded += 1; continue; } // skip HA's own agent/voice-pipeline entities
    const room = roomOf.get(e.entity_id) || UNASSIGNED;
    if (!rooms.has(room)) rooms.set(room, new Map());
    const byDomain = rooms.get(room);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push({ entity_id: e.entity_id, name: e.attributes?.friendly_name || e.entity_id, state: e.state });
  }

  // ── node registry + memoization (stable handles across repeated navigation) ──
  const handles = new Map();   // handle → node
  const memo = new Map();      // cacheKey → node
  const regNode = (key, node, handle) => { memo.set(key, node); handles.set(handle, node); return node; };

  const liveState = async entity_id => {
    try { const r = await fetch(`${REST}/api/states/${entity_id}`, { headers: auth, signal: AbortSignal.timeout(8000) }); if (!r.ok) return { state: `(${r.status})` }; const j = await r.json(); return { state: j.state, attributes: j.attributes }; }
    catch (e) { return { state: `(error: ${e.message})` }; }
  };
  const callService = async (domain, service, data) => {
    try { const r = await fetch(`${REST}/api/services/${domain}/${service}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(data || {}), signal: AbortSignal.timeout(12000) }); return harden({ ok: r.ok, status: r.status, result: r.ok ? await r.json().catch(() => []) : (await r.text()).slice(0, 200) }); }
    catch (e) { return harden({ ok: false, error: e.message }); }
  };

  // ── ENTITY node ──────────────────────────────────────────────────────────
  const makeEntity = (rec, ro) => {
    const key = `entity:${rec.entity_id}:${ro ? 'ro' : 'rw'}`;
    if (memo.has(key)) return memo.get(key);
    const handle = newHandle();
    const domain = rec.entity_id.split('.')[0];
    const allowed = DOMAIN_ACTIONS[domain] || [];
    const base = {
      help: () => `Home Assistant entity ${rec.entity_id} (${rec.name}).${ro ? ' READ-ONLY.' : ` actions: ${allowed.join(', ') || '(none)'} — each PROPOSES (you confirm).`}`,
      describe: () => harden({ kind: 'ha-entity', handle, entity_id: rec.entity_id, name: rec.name, domain, state: rec.state, readOnly: !!ro, actions: ro ? [] : allowed }),
      state: async () => harden({ entity_id: rec.entity_id, ...(await liveState(rec.entity_id)) }),
      readOnly: () => makeEntity(rec, true),
    };
    if (!ro && allowed.length) {
      base.actions = () => harden(allowed.slice());
      // act() does NOT fire — it registers a confirmable proposal whose commit
      // captures THIS entity's actuator. The entity_id is closed over from HA's
      // own data; nothing the agent/holder typed re-designates the target.
      base.act = (action, data) => {
        const svc = String(action || '');
        if (!allowed.includes(svc)) throw new Error(`entity ${rec.entity_id} has no action "${svc}" (allowed: ${allowed.join(', ')})`);
        return propose({
          type: 'home-assistant', power: 'homeassistant',
          title: `${svc.replace(/_/g, ' ')} — ${rec.name}`,
          summary: `${domain}.${svc} → ${rec.entity_id}`,
          detail: { entity_id: rec.entity_id, name: rec.name, service: `${domain}.${svc}`, data: data || {} },
          commit: () => callService(domain, svc, { entity_id: rec.entity_id, ...(data || {}) }),
        });
      };
    }
    return regNode(key, Far(`HAEntity(${rec.entity_id})${ro ? '·ro' : ''}`, base), handle);
  };

  // ── TYPE (domain within a room) node ───────────────────────────────────────
  const makeType = (room, domain, recs, ro) => {
    const key = `type:${room}|${domain}:${ro ? 'ro' : 'rw'}`;
    if (memo.has(key)) return memo.get(key);
    const handle = newHandle();
    const node = Far(`HAType(${room}/${domain})${ro ? '·ro' : ''}`, {
      help: () => `${recs.length} ${domain} entit${recs.length === 1 ? 'y' : 'ies'} in ${room}.${ro ? ' READ-ONLY.' : ''} entity(id)/entities()/readOnly().`,
      describe: () => harden({ kind: 'ha-type', handle, room, domain, readOnly: !!ro, entities: recs.map(r => ({ entity_id: r.entity_id, name: r.name, state: r.state, handle: makeEntity(r, ro).describe().handle })) }),
      entities: () => harden(recs.map(r => { const d = makeEntity(r, ro).describe(); return { entity_id: d.entity_id, name: d.name, handle: d.handle }; })),
      entity: id => { const r = recs.find(x => x.entity_id === String(id)); if (!r) throw new Error(`no entity "${id}" in ${room}/${domain}`); return makeEntity(r, ro); },
      readOnly: () => makeType(room, domain, recs, true),
    });
    return regNode(key, node, handle);
  };

  // ── ROOM node ──────────────────────────────────────────────────────────────
  const makeRoom = (room, byDomain, ro) => {
    const key = `room:${room}:${ro ? 'ro' : 'rw'}`;
    if (memo.has(key)) return memo.get(key);
    const handle = newHandle();
    const node = Far(`HARoom(${room})${ro ? '·ro' : ''}`, {
      help: () => `Room "${room}": ${[...byDomain.keys()].join(', ')}.${ro ? ' READ-ONLY.' : ''} type(domain)/types()/readOnly().`,
      describe: () => harden({ kind: 'ha-room', handle, name: room, readOnly: !!ro, types: [...byDomain.entries()].map(([d, recs]) => ({ domain: d, count: recs.length, handle: makeType(room, d, recs, ro).describe().handle })) }),
      types: () => harden([...byDomain.entries()].map(([d, recs]) => ({ domain: d, count: recs.length, handle: makeType(room, d, recs, ro).describe().handle }))),
      type: d => { const recs = byDomain.get(String(d)); if (!recs) throw new Error(`room "${room}" has no ${d}`); return makeType(room, String(d), recs, ro); },
      search: query => { const q = String(query || '').toLowerCase(); const out = []; for (const [domain, recs] of byDomain) for (const rec of recs) if (!q || rec.entity_id.toLowerCase().includes(q) || rec.name.toLowerCase().includes(q)) { out.push({ handle: makeEntity(rec, ro).describe().handle, entity_id: rec.entity_id, name: rec.name, room, domain, state: rec.state }); if (out.length >= 40) return harden(out); } return harden(out); },
      readOnly: () => makeRoom(room, byDomain, true),
    });
    return regNode(key, node, handle);
  };

  // ── ROOT node ────────────────────────────────────────────────────────────
  const makeRoot = ro => {
    const key = `root:${ro ? 'ro' : 'rw'}`;
    if (memo.has(key)) return memo.get(key);
    const handle = newHandle();
    const node = Far(`HomeAssistant${ro ? '·ro' : ''}`, {
      help: () => `Home Assistant: ${rooms.size} rooms, ${states.length} entities.${ro ? ' READ-ONLY.' : ''} room(name)/rooms()/readOnly().`,
      describe: () => harden({ kind: 'ha-root', handle, label: 'Home Assistant', readOnly: !!ro, rooms: [...rooms.entries()].map(([name, bd]) => ({ name, domains: bd.size, entities: [...bd.values()].reduce((n, a) => n + a.length, 0), handle: makeRoom(name, bd, ro).describe().handle })) }),
      rooms: () => harden([...rooms.entries()].map(([name, bd]) => ({ name, handle: makeRoom(name, bd, ro).describe().handle }))),
      room: name => { const bd = rooms.get(String(name)); if (!bd) throw new Error(`no room "${name}"`); return makeRoom(String(name), bd, ro); },
      search: query => { const q = String(query || '').toLowerCase(); const out = []; for (const [room, bd] of rooms) for (const [domain, recs] of bd) for (const rec of recs) if (!q || rec.entity_id.toLowerCase().includes(q) || rec.name.toLowerCase().includes(q)) { out.push({ handle: makeEntity(rec, ro).describe().handle, entity_id: rec.entity_id, name: rec.name, room, domain, state: rec.state }); if (out.length >= 40) return harden(out); } return harden(out); },
      readOnly: () => makeRoot(true),
    });
    return regNode(key, node, handle);
  };

  const root = makeRoot(false);
  return harden({
    configured: true,
    root,
    nodeByHandle: h => handles.get(String(h || '')) || null,
    roomCount: rooms.size,
    entityCount: states.length - excluded,
    excluded,
    withRegistry: !!reg,
  });
};
harden(makeHaTrie);
