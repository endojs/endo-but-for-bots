// custom-tools.mjs — agent-PROPOSED, human-REVIEWED tools admitted into the library.
//
// A tool is PURE JAVASCRIPT, not a pure function: its code is `make(powers)` (the Endo unconfined-guest
// convention) returning a STATEFUL object — methods closing over private state — so a tool is a
// persistent, stateful participant in an application, not a thing recomputed each call. It is:
//   • instantiated ONCE and kept alive  → in-process state persists across calls;
//   • endowed with a durable `state` cap → it persists/recalls across restarts;
//   • SES-confined → its ONLY authority is the powers we hand it (state + console today). No ambient
//     fs / process / network / import.
// Lifecycle: proposeTool → PENDING (not callable, not injected) → owner reviews the code → admit →
// it's a first-class library object. (delegateTask returns a delegate's proposals as data, never injects.)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bundleMakeBody, bundleFiles, instantiateBundle } from './tool-bundle.mjs';
import { makeGrainStore } from './grain-store.mjs';

const HOME = process.env.HOME || '/home/dan';
const STORE = process.env.CUSTOM_TOOLS_STORE || `${HOME}/.config/field-agent/custom-tools.json`;
const STATE_DIR = process.env.CUSTOM_TOOLS_STATE || `${HOME}/.local/state/field-agent/tool-state`;
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)}…` : t; };

export const makeCustomTools = () => {
  const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')).tools || []; } catch { return []; } };
  const save = ts => { try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify({ tools: ts }, null, 2), { mode: 0o600 }); } catch { /* best effort */ } };
  const safeName = n => String(n || 'tool').replace(/[^\w.-]/g, '_').slice(0, 60) || 'tool';

  // DURABLE per-tool state (a tool's memory across restarts) — a small disk-backed kv, namespaced by
  // tool id. This is the controlled persistence surface; the tool gets nothing else from the host.
  const makeState = id => {
    const file = path.join(STATE_DIR, `${id}.json`);
    const rd = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
    const wr = o => { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(o, null, 2), { mode: 0o600 }); } catch { /* best effort */ } };
    return harden({
      get: k => { const v = rd()[String(k)]; return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
      set: (k, v) => { const o = rd(); o[String(k)] = v; wr(o); return v; },
      delete: k => { const o = rd(); delete o[String(k)]; wr(o); return true; },
      all: () => rd(),
    });
  };

  const instances = new Map(); // toolId → live instance (kept alive → in-process state persists)
  const built = new Map(); // toolId → built bundle for a multi-file class (bundle the dir once)
  const bundleFor = async tool => { if (!built.has(tool.id)) built.set(tool.id, await bundleFiles(tool.files, tool.entry || 'tool.js')); return built.get(tool.id); };
  // DURABLE GRAINS — the component's DATA as mergeable, subscribable cells, keyed by component id and
  // stored SEPARATELY from its git source, so the data SURVIVES a source swap (revert/fork/edit).
  const grainStore = makeGrainStore({ dir: process.env.COMPONENT_GRAINS || `${HOME}/.local/state/field-agent/component-grains` });
  const instantiate = async tool => {
    const powers = harden({ state: makeState(tool.id), grains: grainStore.grainsFor(tool.id), console: harden({ log: () => {}, error: () => {} }) });
    if (tool.bundle) return instantiateBundle(tool.bundle, powers); // imported class — a real Endo bundle
    if (tool.files) return instantiateBundle(await bundleFor(tool), powers); // multi-file class — bundle the dir, instantiate
    // single-file tool: code is the body of make(powers), returning the tool (fn or {methods}).
    const compartment = new Compartment(harden({ console: harden({ log: () => {}, error: () => {} }), harden }));
    const make = compartment.evaluate(`(async (powers) => {\n${tool.code}\n})`);
    return make(powers);
  };
  const getInstance = async tool => { if (!instances.has(tool.id)) instances.set(tool.id, await instantiate(tool)); return instances.get(tool.id); };
  const methodsOf = inst => { try { if (typeof inst === 'function') return ['(call)']; if (inst && typeof inst.__getMethodNames__ === 'function') return [...inst.__getMethodNames__()]; return inst && typeof inst === 'object' ? Object.keys(inst).filter(k => typeof inst[k] === 'function') : []; } catch { return []; } };

  // kind: 'instance' = one stateful object hosted HERE (singleton, my state). 'class' = a shareable
  // module others import + instantiate LOCALLY (their own instance, their own state).
  // sanitize a multi-file map: {relpath: source}, capped count/size. The entry must be present.
  const cleanFiles = (files, entry) => {
    if (!files || typeof files !== 'object') return null;
    const out = {}; let n = 0;
    for (const [k, v] of Object.entries(files)) { if (++n > 40) break; const rel = String(k).replace(/^[/\\]+/, '').slice(0, 120); if (rel && !rel.includes('..')) out[rel] = String(v ?? '').slice(0, 40000); }
    return out[entry] ? out : null;
  };
  const propose = ({ name, description, code, args, kind, bundle, files, entry, proposedBy, now }) => {
    const id = `tool-${crypto.randomBytes(5).toString('hex')}`;
    const ent = String(entry || 'tool.js');
    const cleaned = files ? cleanFiles(files, ent) : null;
    const k = (kind === 'class' || cleaned) ? 'class' : 'instance'; // multi-file ⇒ class
    const rec = { id, name: safeName(name), description: clip(description, 300), args: (args && typeof args === 'object') ? args : {}, kind: k, proposedBy: String(proposedBy || ''), status: 'pending', createdAt: now || '' };
    if (cleaned) { rec.files = cleaned; rec.entry = ent; } // multi-file class
    else if (bundle) rec.bundle = String(bundle).slice(0, 400000); // imported real bundle
    else rec.code = String(code || '').slice(0, 40000); // single-file
    save(load().concat(rec));
    return { ok: true, id, name: rec.name, kind: rec.kind, multifile: !!cleaned };
  };
  // Export a CLASS as a REAL, portable, multi-module Endo bundle (via @endo/compartment-mapper makeBundle
  // — the SMR engine bundle-source wraps). The recipient imports it + hosts their OWN local instance.
  const exportClass = async id => {
    const t = get(id); if (!t) return { ok: false, error: 'no such tool' };
    let bundle; try { bundle = t.bundle || (t.files ? await bundleFiles(t.files, t.entry || 'tool.js') : await bundleMakeBody(t.code)); } catch (e) { return { ok: false, error: `bundling failed: ${(e && e.message) || e}` }; }
    return harden({ ok: true, bundle: { format: 'endo-bundle-v1', moduleEntry: 'make(powers)', name: t.name, description: t.description, args: t.args, bundle } });
  };
  // Import someone else's class bundle → register as a PENDING class for the owner to review + admit,
  // then host locally. (Imported bundles are reviewed exactly like home-grown code — never auto-admitted.)
  const importClass = ({ bundle, proposedBy, now }) => {
    if (!bundle) return { ok: false, error: 'no bundle' };
    if (bundle.bundle) return propose({ name: bundle.name, description: `[imported class] ${bundle.description || ''}`, args: bundle.args, kind: 'class', bundle: bundle.bundle, proposedBy, now }); // real Endo bundle
    if (bundle.source) return propose({ name: bundle.name, description: `[imported class] ${bundle.description || ''}`, code: bundle.source, args: bundle.args, kind: 'class', proposedBy, now }); // legacy source-record envelope
    return { ok: false, error: 'not a valid class bundle (needs {bundle} or {source})' };
  };
  const pendingBy = agentId => load().filter(t => t.status === 'pending' && t.proposedBy === String(agentId)).map(t => ({ id: t.id, name: t.name, description: t.description }));
  const get = idOrName => load().find(t => t.id === String(idOrName) || t.name === String(idOrName)) || null;
  const listAll = () => load().map(t => ({ id: t.id, name: t.name, description: t.description, status: t.status, kind: t.kind || 'instance', proposedBy: t.proposedBy, code: t.code, files: t.files, entry: t.entry, hasBundle: !!t.bundle, review: t.review || null, reviseLog: t.reviseLog || null }));
  // Persist the discipline-review panel's findings on a pending tool so the admission gate sees them.
  const setReview = (id, review) => { const ts = load(); const t = ts.find(x => x.id === String(id)); if (!t) return { ok: false, error: 'no such proposal' }; t.review = review; save(ts); return { ok: true }; };
  // Persist the review→revise dialogue (the developer's resolutions per round) so the human sees how the
  // panel's criticisms were integrated/noted/unified before admitting an already-improved component.
  const setReviseLog = (id, reviseLog) => { const ts = load(); const t = ts.find(x => x.id === String(id)); if (!t) return { ok: false, error: 'no such proposal' }; t.reviseLog = reviseLog; save(ts); return { ok: true }; };
  // Replace a tool's SOURCE (e.g. after reverting its git-as-Endo component to an earlier version) and
  // drop its cached instance/bundle so the next call re-instantiates from the new source.
  const setSource = (id, files) => {
    const ts = load(); const t = ts.find(x => x.id === String(id)); if (!t) return { ok: false, error: 'no such tool' };
    if (t.files) t.files = files; else t.code = String((files && (files['tool.js'] ?? Object.values(files)[0])) || '');
    save(ts); instances.delete(t.id); built.delete(t.id);
    return { ok: true };
  };
  // Copy one component's grain DATA to another id — used when a fork should start from the source's data.
  const copyGrains = (fromId, toId) => { grainStore.copy(String(fromId), String(toId)); return { ok: true }; };
  // The component's live grain DATA {name: value} — read-only, for the Studio (shows data survives edits).
  const grainData = id => grainStore.dump(String(id));
  const list = () => load().filter(t => t.status === 'admitted').map(t => ({ id: t.id, name: t.name, description: t.description, args: t.args, kind: t.kind || 'instance' }));
  const admit = id => { const ts = load(); const t = ts.find(x => x.id === String(id)); if (!t) return { ok: false, error: 'no such proposal' }; t.status = 'admitted'; save(ts); instances.delete(t.id); built.delete(t.id); return { ok: true, id: t.id, name: t.name }; };
  const reject = id => { instances.delete(String(id)); built.delete(String(id)); save(load().filter(t => t.id !== String(id))); return { ok: true, id: String(id) }; };

  // Call an ADMITTED tool. A stateful tool exposes methods → pass {method, args}. A single-function tool
  // → pass {args}. The instance is kept alive, so its state persists across calls (+ durably via `state`).
  const call = async (idOrName, { method, args = {} } = {}) => {
    const t = get(idOrName);
    if (!t) return { ok: false, error: 'no such tool' };
    if (t.status !== 'admitted') return { ok: false, error: `tool "${t.name}" is ${t.status} — not yet admitted by the owner` };
    let inst; try { inst = await getInstance(t); } catch (e) { return { ok: false, error: `tool failed to initialize: ${(e && e.message) || e}` }; }
    try {
      if (method) { if (typeof inst?.[method] !== 'function') return { ok: false, error: `"${t.name}" has no method "${method}" (has: ${methodsOf(inst).join(', ')})` }; return harden({ ok: true, value: await inst[method](args) }); }
      if (typeof inst === 'function') return harden({ ok: true, value: await inst(args) });
      return { ok: false, error: `"${t.name}" is a stateful object — pass a method (one of: ${methodsOf(inst).join(', ')})` };
    } catch (e) { return harden({ ok: false, error: (e && e.message) || String(e) }); }
  };

  return { propose, pendingBy, get, list, listAll, setReview, setReviseLog, setSource, copyGrains, grainData, admit, reject, call, methodsOf, getInstance, exportClass, importClass };
};
