// codemode.mjs — CodeMode agent loop (Cloudflare-style) for Agent C, ocap-confined by SES.
//
// Instead of the model emitting one `TOOL_CALL:{name,args}` per turn, it writes a JS PROGRAM
// that calls the granted capabilities as in-scope async functions, composing them with normal
// control flow (loops, branches, chaining) and `return`-ing a result. The program runs in a
// hardened SES `Compartment` whose ONLY globals are the granted caps (+ console) — so confinement
// is the Compartment's lexical scope: there is no name for a power the bundle doesn't hold, and
// no `process`/`require`/`fs`/host realm to escape into. The cap bundle IS the sandbox API; the
// lexical scope IS the confinement. (Verified: `typeof process === 'undefined'` inside.)
//
// This is THE agent loop (the legacy text-marker runAgent in tool-bridge.mjs was retired).
import '@endo/init';
import { callLLM as defaultCallLLM, buildUserContent as defaultBuildUserContent } from './tool-bridge.mjs';

// Run ONE model-authored program in a fresh confined Compartment. Endowments = the cap wrappers
// (each toolbox verb as an async fn `name(args)`) + a captured console. Returns {ok, value, logs, error}.
const runProgram = async (code, endow) => {
  const logs = [];
  const con = harden({
    log: (...a) => { logs.push(a.map(x => (typeof x === 'string' ? x : safeJson(x))).join(' ')); },
    error: (...a) => { logs.push(`ERROR: ${a.map(x => (typeof x === 'string' ? x : safeJson(x))).join(' ')}`); },
  });
  try {
    // Endowments become the Compartment's globals. The cap fns close over host authority — that IS
    // the authority bridge; nothing else (no process/require/fs/import) is reachable from inside.
    // REL-3: construct the Compartment INSIDE the try — a throw from `new Compartment` (e.g. a bad
    // endowment) must become a structured {ok:false,error}, never an escaped rejection that unwinds
    // the whole agent loop (and, upstream, the /chat window).
    const compartment = new Compartment(harden({ ...endow, console: con }));
    // wrap as an async IIFE so the program may `await` caps and `return` a value
    const value = await compartment.evaluate(`(async () => {\n${String(code)}\n})()`);
    return { ok: true, value, logs };
  } catch (e) {
    // P1-7(a): distinguish a PARSE failure (the generated program didn't compile — truncation, an unbalanced
    // brace/quote/fence) from a RUNTIME throw. A SyntaxError is thrown SYNCHRONOUSLY by compartment.evaluate
    // before the async IIFE ever runs; the loop uses this flag to auto-retry program-generation once instead
    // of surfacing the raw SyntaxError as the turn result. (Name-check too: SES compartments share primordials
    // with the start compartment, so `instanceof` holds — the name guard is belt-and-suspenders.)
    const syntax = e instanceof SyntaxError || (!!e && e.name === 'SyntaxError');
    return { ok: false, error: (e && e.message) || String(e), logs, ...(syntax ? { syntax: true } : {}) };
  }
};

// A non-throwing, descriptive walk for values JSON.stringify chokes on (live Endo remotables whose proxy
// traps throw mid-stringify, circular graphs, bare functions). It NEVER yields a raw "[object Object]":
// records become { k: v } literals, arrays are element-walked, remotables surface their interface tag, and
// every per-property access is guarded. This is the fallback for safeJson + the object-channel `sample`.
const describeValue = (v, depth = 0, seen = new WeakSet()) => {
  if (v === null || v === undefined) return String(v);
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v.length > 2000 ? `${v.slice(0, 2000)}…` : v);
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'bigint') return `${v}n`;
  if (t === 'symbol') { try { return v.toString(); } catch { return '«symbol»'; } }
  if (t === 'function') return `[Function ${v.name || 'anon'}]`;
  if (depth > 6) return '…';
  if (seen.has(v)) return '«circular»';
  seen.add(v);
  if (Array.isArray(v)) return `[${v.slice(0, 50).map(x => { try { return describeValue(x, depth + 1, seen); } catch { return '«?»'; } }).join(', ')}${v.length > 50 ? `, …(+${v.length - 50})` : ''}]`;
  try { if (typeof v.then === 'function') return '[Promise]'; } catch { /* thenable getter threw */ }
  let keys = null; try { keys = Object.keys(v); } catch { keys = null; }
  if (keys && keys.length) return `{ ${keys.slice(0, 40).map(k => { let val; try { val = describeValue(v[k], depth + 1, seen); } catch { val = '«throws»'; } return `${k}: ${val}`; }).join(', ')}${keys.length > 40 ? ', …' : ''} }`;
  // no enumerable own keys → likely a remotable/presence; surface its interface tag if any
  let tag = '[remotable]'; try { const s = Object.prototype.toString.call(v); tag = s.includes('Alleged') ? `[${s.slice(8, -1)}]` : '[remotable object]'; } catch { /* */ }
  return tag;
};
const safeJson = v => { try { const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)); return s === undefined ? describeValue(v) : s; } catch { return describeValue(v); } };
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)}…[${t.length - n} more chars]` : t; };

// ── OBJECT CHANNEL (increment 1a) ────────────────────────────────────────────────────────────────────────
// When a program hands answer()/ask()/blocked() a NON-STRING value — a live Endo Remotable/exo, a plain
// object/array, a promise, or a bare capability — we must NOT coerce it to "[object Object]" and LOSE the live
// data. Instead we CAPTURE a structured, cap-SAFE descriptor and carry it out-of-band on the turn result as the
// `objects` channel (mirrors how tool widgets ride on `ui`). The queued CLIENT increment renders these via its
// valNode drill-down tree + the blossom renderer library, with a "🌱 blossom this / change how this looks"
// affordance. THE CONTRACT — one descriptor per captured object:
//   {
//     kind:      'object' | 'array' | 'remotable' | 'promise' | 'cap',  // best-effort type tag
//     name:      string,     // a human label (interface tag / "Array(n)" / constructor), NEVER a swissnum
//     methods:   string[],   // callable method names (via __getMethodNames__ or own function props), sorted
//     sample:    string,     // render-safe, cap-SCRUBBED JSON/preview of the value (bounded ~1200 chars)
//     preview:   string,     // one-line clip used for the in-text placeholder
//     redacted?: boolean,    // true ⇒ the value WAS a bare cap/swissnum: sample is a marker, not the secret
//   }
// The SERVER enriches each with `blossomSig` (= blossom.sigOf(methods, kind)) at /chat assembly time, since the
// blossom renderer library lives server-side; codemode stays free of that coupling. Cap hygiene: `sample` and
// `name` are scrubbed here (and again server-side); a value that is nothing but a cap/swissnum is redacted.
const CAP_RE = /#cap=[0-9a-fA-F]{16,}|#k=[\w-]{16,}|#agent=[\w-]{8,}|\b[0-9a-f]{32}\b/;
// a string that is NOTHING BUT a cap/swissnum (anchored) → redact the whole reply; an EMBEDDED cap inside prose
// is merely scrubbed (prose preserved) via scrubCapText.
const BARE_CAP_RE = /^\s*(?:#cap=[0-9a-fA-F]{16,}|#k=[\w-]{16,}|#agent=[\w-]{8,}|[0-9a-f]{32})\s*$/;
const scrubCapText = s => String(s == null ? '' : s)
  .replace(/#cap=[0-9a-fA-F]{16,}/g, '#cap=«redacted»')
  .replace(/#k=[\w-]{16,}/g, '#k=«redacted»')
  .replace(/#agent=[\w-]{8,}/g, '#agent=«redacted»')
  .replace(/\b[0-9a-f]{32}\b/g, '«swissnum»');
const methodNamesOf = o => {
  try { if (o && typeof o.__getMethodNames__ === 'function') return [...new Set([...o.__getMethodNames__()].map(String).filter(Boolean))].sort(); } catch { /* */ }
  try { if (o && typeof o === 'object') return [...new Set(Object.keys(o).filter(k => { try { return typeof o[k] === 'function'; } catch { return false; } }))].sort(); } catch { /* */ }
  return [];
};
const ifaceTag = o => { try { const s = Object.prototype.toString.call(o); if (s.includes('Alleged')) return s.slice(8, -1); } catch { /* */ } return ''; };
// Build a cap-safe descriptor for a value handed to a turn-ender, or null if it is an ordinary scalar/string
// that needs no object channel (a plain string reply, a number, a boolean).
const describeRef = v => {
  if (v == null) return null;
  const t = typeof v;
  if (t === 'string') {
    // a string reply that IS nothing but a bare cap/swissnum → redact it entirely (never surface the secret).
    // (An EMBEDDED cap inside prose is handled by scrubCapText at the call site, which keeps the prose.)
    return BARE_CAP_RE.test(v) ? { kind: 'cap', name: 'capability', methods: [], sample: '«redacted capability»', preview: '«redacted capability»', redacted: true } : null;
  }
  if (t !== 'object' && t !== 'function') return null; // number/boolean/bigint/symbol → coerce, no channel
  let hasGMN = false; try { hasGMN = typeof v.__getMethodNames__ === 'function'; } catch { /* */ }
  // a bare thenable (not a remotable) → the "[object Promise]" smell
  let thenable = false; try { thenable = typeof v.then === 'function' && !hasGMN; } catch { /* */ }
  if (thenable) return { kind: 'promise', name: 'Promise', methods: [], sample: '[Promise — hand answer() the awaited value, not the promise]', preview: '[Promise]' };
  const methods = methodNamesOf(v);
  const sample = scrubCapText(clip(safeJson(v), 1200));
  let kind; let name;
  if (Array.isArray(v)) { kind = 'array'; name = `Array(${v.length})`; }
  else {
    const tag = ifaceTag(v);
    let hasKeys = false; try { hasKeys = Object.keys(v).length > 0; } catch { /* */ }
    // a __getMethodNames__-bearing exo/Far, an interface-tagged presence, or a keyless object with methods → remotable
    if (hasGMN || tag || (methods.length && !hasKeys)) { kind = 'remotable'; name = tag || 'remotable'; }
    else { let cn = ''; try { cn = v.constructor && v.constructor.name; } catch { /* */ } kind = 'object'; name = cn && cn !== 'Object' ? cn : 'object'; }
  }
  return { kind, name: scrubCapText(name), methods, sample, preview: clip(sample, 160) };
};
// The clean, legible in-text placeholder that REPLACES the destroyed "[object Object]" — references the carried
// descriptor so even before the rich client render ships, the user sees something meaningful.
const refPlaceholder = d => {
  if (d.redacted) return '🌱 capability (redacted — not shown)';
  const summary = d.methods && d.methods.length ? `${d.methods.slice(0, 4).join(', ')}${d.methods.length > 4 ? ', …' : ''}` : (d.name || 'value');
  return `🌱 ${d.kind} — ${d.name && d.name !== d.kind ? d.name : summary} (unrendered object)`;
};

// ── ANSWER-CHANNEL HYGIENE (P1-7) ──────────────────────────────────────────────────────────────────────────
// The user-visible reply must never BE a raw artefact of the machinery: a whole ```js program dumped as the
// answer, a raw provider-error JSON blob, or a stray unfenced program. These are malfunctions, not replies.
// Detect them defensively (all guards non-throwing, bounded) and REPLACE with a clean recovery message. Prose
// that merely CONTAINS a code snippet or the word "error" is untouched — only a WHOLE-answer artefact is caught.
// (The `[object Object]` smell is handled separately by the object channel above + server-side de-smell.)
const FENCE_WHOLE_RE = /^\s*```[\s\S]*```\s*$/;
// a raw provider-error blob: a JSON object/array whose top level carries an error/message/type key alongside a
// telltale transport/limit token (429/5xx/rate-limit/overloaded/…). Anchored to a JSON-looking start to avoid
// catching ordinary prose that merely mentions "error".
const looksLikeProviderError = s => {
  const t = String(s == null ? '' : s).trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  return /["']?(error|message|type|status)["']?\s*:/.test(t)
    && /(rate.?limit|overloaded|invalid_request|api|token|quota|status|\b(?:429|500|502|503|529)\b|unauthor|forbidden|exception|econnreset|timed?.?out)/i.test(t);
};
// an unfenced JS PROGRAM emitted as if it were prose: starts like a JS statement AND carries program structure.
// Kept strict (both conditions) so a natural-language sentence that happens to start with "if"/"for" is not caught.
const looksLikeRawProgram = s => {
  const t = String(s == null ? '' : s).trim();
  if (t.length < 8) return false;
  const startsJs = /^(?:await\s|const\s|let\s|var\s|function\s|async\s|for\s*\(|while\s*\(|if\s*\(|switch\s*\(|try\s*\{|return\s|answer\s*\(|ask\s*\(|blocked\s*\(|\/\/)/.test(t);
  const hasStructure = /=>/.test(t) || /;\s*$/m.test(t) || /\bawait\s+\w+\s*\(/.test(t) || /^\s*(?:const|let|var)\s+\w+\s*=/.test(t);
  return startsJs && hasStructure;
};
// Lint one piece of user-visible answer text; returns a clean message if it is a raw artefact, else the input.
const answerHygiene = text => {
  const t = String(text == null ? '' : text);
  const trimmed = t.trim();
  if (!trimmed) return text;
  // (1) the WHOLE answer is a single fenced code block → a program/log dump leaked in place of a reply.
  if (FENCE_WHOLE_RE.test(trimmed) && (trimmed.match(/```/g) || []).length >= 2) {
    return 'I generated a code step instead of a reply. Let me try that again — could you restate what you need?';
  }
  // (2) a raw provider-error JSON blob became the reply.
  if (looksLikeProviderError(trimmed)) {
    return 'I hit a temporary problem reaching the model just now. Please try again in a moment.';
  }
  // (3) an unfenced program dumped as prose.
  if (looksLikeRawProgram(trimmed)) {
    return 'I started to write a code step but did not run it as a reply. Let me try again — could you restate what you need?';
  }
  return text;
};

// Extract a JS program from the model reply: a ```js fenced block (preferred), else a bare ``` block.
const extractCode = reply => {
  const s = String(reply || '');
  const closed = /```(?:js|javascript)?\s*\n([\s\S]*?)```/i.exec(s);
  if (closed) return closed[1].trim();
  // TRUNCATION-TOLERANT: a program long enough to hit the output-token limit arrives with an OPENING
  // fence but no closing one. Take everything after the open fence as the code — it likely throws (a
  // syntax error from being cut off), which feeds back as OUTPUT so the model finishes/splits it,
  // rather than silently being treated as the final answer (the bug that left the scout's program unrun).
  const open = /```(?:js|javascript)?\s*\n([\s\S]+)$/i.exec(s);
  return open ? open[1].trim() : null;
};

export const runAgentCode = async ({ toolbox, manifest, userText, history = [], onStep = () => {}, signal, persona = '', attachments = [], model = 'default', llm, budgetLine = '', resumeMessages = null, callLLM = defaultCallLLM, buildUserContent = defaultBuildUserContent, takeInterjections = () => [], allowResearch = false, persist = null, sideEffectLedger = null, destructiveVerbs = null } = {}) => {
  const invoke = llm || callLLM;
  const used = [];
  // P1-5: injected, OPTIONAL capabilities (endowments of the LOOP, NOT of the program's Compartment — SES
  // confinement is unchanged; the program can't name them). `persist(transcript)` durably saves the in-flight
  // transcript-with-outputs at each step boundary so a restart RECOVERS by replay, not re-run. `sideEffectLedger`
  // (+ `destructiveVerbs`) is the at-most-once guard for destructive verbs. Both default null → byte-identical to
  // the pre-P1-5 loop (the in-process top-up resume path in resume.test.mjs is unaffected).
  const persistTranscript = typeof persist === 'function' ? persist : null;
  const ledger = sideEffectLedger && destructiveVerbs && typeof destructiveVerbs.has === 'function' ? sideEffectLedger : null;
  // Wrap every toolbox verb as an async fn the program can call: `await name(args)`. Each emits the
  // same onStep events as the classic loop, so the trace/pendant + toolsUsed keep working.
  // wrap one invocation so it emits the trace + records usage + never throws past the sandbox.
  const wrapCall = (label, fn) => harden(async (args = {}) => {
    if (signal?.aborted) throw new Error('aborted');
    onStep({ kind: 'tool-start', name: label, args });
    // P1-5 IDEMPOTENCY LEDGER: for a DESTRUCTIVE verb, consult a durable at-most-once ledger so a recovery
    // re-run (after a mid-turn restart) that re-invokes an already-committed side effect returns the PRIOR
    // result instead of firing it AGAIN. Fail-safe: a null callKey (ledger unavailable) → run the verb normally.
    const guarded = !!(ledger && destructiveVerbs.has(label));
    let callKey = null;
    if (guarded) {
      callKey = ledger.callKey(label, args);
      const prior = callKey ? ledger.recall(callKey) : null;
      if (prior && prior.hit) { used.push({ name: label, args, result: prior.result }); onStep({ kind: 'tool', name: label, args, result: prior.result, replayed: true }); return prior.result; }
      if (callKey) ledger.markPending(callKey); // write-ahead intent: a crash mid-effect leaves a durable trace
    }
    try {
      const r = await fn(args || {});
      if (callKey) ledger.settle(callKey, r); // record iff it committed a real effect; else clear the pending marker
      used.push({ name: label, args, result: r }); onStep({ kind: 'tool', name: label, args, result: r }); return r;
    }
    catch (e) {
      if (callKey) ledger.clearPending(callKey); // a throw = no committed effect → let a retry/replay run it
      // REL-3: budget exhaustion during a METERED sub-call (delegateTask → Opus refuses before any paid
      // call when the purse can't cover its floor) is NOT an ordinary tool error to be swallowed and run
      // past — it must route to the turn-level EXHAUSTED / top-up path. Re-throw so the loop converts it.
      if (e && e.code === 'INFERENCE_BUDGET_EXHAUSTED') throw e;
      onStep({ kind: 'tool-error', name: label, error: (e && e.message) || String(e) }); return harden({ ok: false, error: (e && e.message) || String(e) });
    }
  });
  const argSig = a => Object.keys(a || {}).length ? 'args' : '';
  const argDoc = a => Object.keys(a || {}).length ? ` — args {${Object.keys(a).map(k => `${k}: ${a[k]}`).join('; ')}}` : '';
  const endow = {}; const apiLines = [];
  for (const t of manifest) {
    const cap = toolbox[t.name];
    if (!cap) continue;
    if (Array.isArray(t.methods) && t.methods.length) {
      // A LIVE Endo remotable OBJECT in your inventory (e.g. a peer, a device, a service). Expose it
      // as a real object whose methods you call directly: `await name.method(args)`. Each method is
      // resolved on the underlying cap (a Far/exo object's own method, or its run({method,args})).
      const obj = {};
      for (const m of t.methods) {
        const invoke = args => (typeof cap[m.name] === 'function' ? cap[m.name](args) : cap.run({ method: m.name, args }));
        obj[m.name] = wrapCall(`${t.name}.${m.name}`, invoke);
      }
      endow[t.name] = harden(obj);
      apiLines.push(`  const ${t.name} = <live object — ${t.description}>; its methods (call directly):\n${t.methods.map(m => `      await ${t.name}.${m.name}(${argSig(m.args)})${argDoc(m.args)} — ${m.description}`).join('\n')}`);
    } else {
      endow[t.name] = wrapCall(t.name, a => cap.run(a));
      apiLines.push(`  async ${t.name}(${argSig(t.args)}): ${t.description}${argDoc(t.args)}`);
    }
  }
  // introspect ANY object reference you hold — returns its callable method names (Endo or plain).
  endow.methodsOf = harden(o => { try { return o && typeof o.__getMethodNames__ === 'function' ? [...o.__getMethodNames__()] : (o && typeof o === 'object' ? Object.keys(o) : []); } catch { return []; } });
  // TURN-ENDING REPLY as a SCOPE FUNCTION, not an `ANSWER:` text marker (dan's principle: control signals are
  // first-class functions in the JS scope, never conventions parsed out of prose — text markers are
  // markdown-/format-/whitespace-fragile). The program ends its turn by calling ONE of:
  //   answer(text)   — the task is complete; deliver the reply.
  //   ask(question)  — you need ONE thing from the user to proceed; ask it and yield the turn.
  //   blocked(reason)— you could NOT complete it; say plainly what you did, what you couldn't, and why.
  // Each records the reply + its KIND and throws a private sentinel to unwind the program immediately; the loop
  // intercepts the captured `finalReply` BEFORE treating that unwind as a program error. All three deliver text
  // the user sees; the kind is a STRUCTURED signal (asking/blocked) for the server/client (logging, "needs you",
  // distinct rendering) — no prose-parsing required.
  let finalReply = null; // { kind: 'answer'|'ask'|'blocked', text, objects: [descriptor,...] }
  const REPLY_SENTINEL = '__codemode_reply__';
  // text is usually a string. If a program passes an OBJECT/array/remotable/promise/cap (e.g. a tool's structured
  // result or a live inventory object handed straight to answer()), we DO NOT coerce it to "[object Object]" and
  // lose it: we CAPTURE a cap-safe descriptor on the `objects` channel (see the CONTRACT above) and put a clean,
  // legible placeholder in the reply text. A bare cap/swissnum (object OR string) is redacted, never surfaced.
  const endTurn = (kind, value) => {
    const objects = [];
    let text;
    if (value == null) text = '';
    else if (typeof value === 'string') {
      const d = describeRef(value); // non-null only when the whole string IS a cap/swissnum
      if (d) { objects.push(d); text = refPlaceholder(d); } else text = scrubCapText(value);
    } else {
      const d = describeRef(value);
      if (d) { objects.push(d); text = refPlaceholder(d); } else text = scrubCapText(safeJson(value)); // scalars: coerce as before
    }
    // P1-7(b): lint the user-visible answer — a raw ```program dump / provider-error blob / unfenced program
    // must never BE the reply. Only for a plain-string reply; a 🌱 object placeholder (objects.length>0) is fine.
    if (objects.length === 0) text = answerHygiene(text);
    // P1-3: an EMPTY explicit turn-ender — answer("")/answer()/whitespace — with NO other captured content is a
    // STALL, not a reply. Do not emit a silent empty assistant bubble: convert it to a `blocked` with a clear
    // message so the DATA is honest (mirrors the empty-model-response path below). A turn that legitimately
    // answers with an object/array/remotable (objects.length>0 → 🌱 placeholder text) is NOT clobbered, and the
    // research handoff (kind==='research', intentionally empty by design) is left untouched.
    if (kind !== 'research' && objects.length === 0 && !String(text == null ? '' : text).trim()) {
      kind = 'blocked';
      text = '(the agent ended its turn without a message)';
    }
    finalReply = { kind, text, objects };
    throw new Error(REPLY_SENTINEL);
  };
  endow.answer = harden(text => endTurn('answer', text));
  endow.ask = harden(question => endTurn('ask', question));
  endow.blocked = harden(reason => endTurn('blocked', reason));
  // research() — a 4th turn-ender (entry agent only; opt-in via allowResearch). Takes NO arguments: it hands the
  // turn off to a fresh, CONFINED public-research agent (web/browser/fetch/research only — NO personal data, NO
  // special/destructive powers), which answers the question from public sources. Because that agent is safe BY
  // CONSTRUCTION (it literally cannot reach private data or act), the handoff needs NO user approval — it widens
  // the set of questions answerable for free. It takes no parameters precisely so nothing (no private context)
  // can be injected across the boundary; the confined agent only sees the public conversation.
  if (allowResearch) endow.researchOnly = harden(() => endTurn('research', ''));
  // MID-TURN PROGRESS (dan): a long multi-step program looks STALLED to the user — the page sits silent
  // while the model thinks + tools run. updateProgress(text) pushes a one-line "here's what I'm doing now"
  // to the live UI WITHOUT ending the turn (unlike answer/ask/blocked). It is a status ping, not a reply:
  // it returns immediately and the program keeps running. Call it before each slow phase of a long task.
  endow.updateProgress = harden(text => { try { onStep({ kind: 'progress', text: String(text == null ? '' : text).slice(0, 280) }); } catch { /* progress is best-effort — never break the program */ } return harden({ ok: true }); });
  apiLines.push('  updateProgress(text): show the user a one-line status of what you are doing RIGHT NOW (e.g. "Reading the bulletin…", "Comparing against our codebase…"). Does NOT end your turn — it keeps running. Call it at the start of each slow phase of a long, multi-step task so the page never looks stalled.');
  // Expose your OWN prompt as read-only variables so you can reference it — or pass a SLICE of it as
  // context to a delegate (e.g. delegateTask({ prompt: `${myPersona}\n\n<the sub-task>` })). myPersona is
  // your operator-confirmed instructions; mySystemPrompt is your full assembled system prompt.
  endow.myPersona = harden(String(persona || ''));
  apiLines.push('  const myPersona = <string: your operator-confirmed instructions>; const mySystemPrompt = <string: your FULL system prompt>. Read-only. Reference them, or pass a slice as context to a delegate — e.g. delegateTask({ prompt: `${myPersona.slice(0, 600)}\\n\\n<sub-task>`, ... }).');
  apiLines.push('  answer(text) / ask(question) / blocked(reason): the THREE ways to END your turn (always in scope). answer(text) = task complete, here is the reply. ask(question) = you need ONE thing from the user to proceed — ask it and yield. blocked(reason) = you could not complete it — say plainly what you did, what you could not, and why. This is HOW you reply; do NOT use an "ANSWER:" text marker. `return` is only for INSPECTING an intermediate value as OUTPUT.');
  if (allowResearch) apiLines.push('  researchOnly(): 4th turn-ender, NO arguments (do NOT confuse with the `research` tool). Call it to HAND OFF the whole question to a fresh CONFINED public-research agent (web/fetch/browser/research, and NOTHING else — no personal data, no special powers), which answers from public sources and whose reply becomes your reply. PREFER it for any question answerable from pure public/world knowledge: the handoff is provably safe (the agent literally cannot touch private data), so it needs NO approval — that is its whole point. Do NOT do the research yourself in that case; just call researchOnly(). Never use it for anything touching the user\'s own data or any action.');
  const api = apiLines.join('\n');
  // Accepted INVENTORY objects are now FIRST-CLASS live in-scope objects in `api` above: the toolbox builds a
  // manifest entry with methods[] for each callable accepted object, so the methods[] branch renders it as
  // `const Name = <live object>; await Name.method(args)` — exactly like any other held Endo object. There is
  // no separate "use callObject" inventory blurb; callObject survives only as the introspection escape hatch.
  const sys = [
    'You are a capable assistant operating in CODE MODE. You act by WRITING A JAVASCRIPT PROGRAM, not by naming a single tool.',
    `The current date and time is ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}. Use it directly.`,
    persona && persona.trim() ? `\nYour instructions (operator-confirmed):\n${persona.trim()}\n` : '',
    attachments && attachments.length ? `\nThe user attached ${attachments.length} file(s) to THIS message — any image is shown inline; look at it directly.` : '',
    budgetLine ? `\n${budgetLine}` : '',
    '',
    'These are your REAL, LIVE capabilities — already wired to real systems and ALREADY IN SCOPE. Calling one DOES the thing (it is not a description or a simulation). Call them directly; do not import, define, or stub them. Some are async functions; some are LIVE OBJECTS whose methods you call (e.g. `await thing.method(args)`). Every name below is a working tool you can use right now:',
    api,
    '',
    'These ARE tools. If you hold a reference to an object (a peer, a device, a contact, a service), it is live — call its methods directly. Unsure what an object offers? `methodsOf(obj)` returns its callable method names. Never say you "cannot" use something that is in scope — call it and read the result.',
    'OBJECTS YOU HOLD ARE LIVE — CALL THEM DIRECTLY. Every Endo object you have accepted appears ABOVE as a live in-scope object; invoke its methods by PROPERTY ACCESS, never by a method-name string: `await Kumavis.send("hi")`, `await Kumavis.inbox()`. Do NOT write `callObject("Kumavis", "send", ...)` for an object that is already in scope, and do NOT guess a bare global like `kumavis(...)` (that is not how you call it). The only time you reach for callObject(name, "describe") is to introspect a NEWLY accepted object whose methods are not yet listed — once described it becomes a live in-scope object too. methodsOf(obj) lists any held reference\'s methods. If a call FAILS (unreachable peer, an error result) that IS the answer: report what you tried + what it said and move on — never retry the same failing call or re-accept the same invite in a loop.',
    '',
    'ANSWER DIRECTLY WHEN YOU CAN — if the user asks a QUESTION you can answer from your own knowledge, and it needs no live/private data, no action, and nothing destructive, just reply immediately with a one-line program that calls `answer(...)`:\n```js\nanswer("<your reply>");\n```\nDo NOT call a tool or delegate/spawn a sub-agent merely to answer something you already know — that adds a wasted cycle and spends credits. Reach for tools or delegation only when you genuinely need to ACT, to fetch data you do not have, or to do work that truly belongs elsewhere. Prefer answering over delegating.',
    'DO YOUR OWN TOOL WORK — do NOT delegate it. If a task is within YOUR tools, just call them and answer (e.g. "is the front door open?" = haFind/haState, then reply). Delegate or employ a sub-agent ONLY when (a) the scope is genuinely too big for one agent (multi-stage work better split across sub-agents or needing a bigger model), OR (b) it involves potentially destructive actions you want carried out by a confined, least-authority sub-agent. A simple read, lookup, or single-tool action is NEVER a reason to delegate.',
    'HOW TO ACT (when the task does need tools) — reply with a single fenced JavaScript program:',
    '```js',
    '// compose freely: call multiple capabilities, loop, branch, use the results',
    "const hits = await searchNotes({ query: 'budget' });",
    'return hits;   // `return` your result (or console.log intermediate values)',
    '```',
    'The program runs in a SECURE SANDBOX: only the capabilities above + console + methodsOf + answer exist. There is no filesystem, network, process, or import — only your granted capabilities. `await` any capability call. `return` a value to INSPECT it (you will see it as OUTPUT, an intermediate step), `console.log(...)` to trace, and call `answer(text)` to deliver your FINAL reply and end the turn.',
    'BIAS TO ACTION: prefer few, well-composed programs over many round-trips — BUT keep each program SHORT enough to finish in one reply (always close the ``` fence). If a task is large, do it across several smaller programs (gather → inspect OUTPUT → act), not one giant block. After OUTPUT, write another program, or call `answer(text)` to give your final reply.',
    'EXTRACT ONCE, THEN OPERATE ON THE STRUCTURE: when a task draws on a DOCUMENT or DATASET across MULTIPLE turns (a PDF schedule, a long page, a table, a transcript), do NOT re-read + re-parse the raw source every prompt — that is slow, spends tokens, and re-derives the same facts. On the FIRST pass, parse the facts you need into a DURABLE DATA STRUCTURE and reuse THAT: save structured JSON to your home folder (fileWrite → fileRead it on later turns), or — best — proposeTool / forgeTool a small grain-backed tool that ingests the data ONCE and exposes query methods (getEventsAt, filterBy, …), or back a component with a grain cell that holds the parsed data. Then on later turns you MANAGE THE DATA PROGRAMMATICALLY (query/filter/transform the structure) instead of re-parsing the original.',
    'WHEN A TASK NEEDS TOOLS, USE THE BREADTH OF YOUR TOOLKIT — the strongest results come from distributing work ACROSS the capabilities you hold and composing them, not fixating on one or two. (This is about HOW to do real work — it is NOT a reason to invoke tools for a question you could just answer.) And act with PRECISION: prefer specific, targeted moves (the exact note, the exact device, the precise parameter/recipient) over broad, coarse ones.',
    'PLAN FIRST, THEN ACT: before you start, think through every step the task needs end to end — INCLUDING how you will PRODUCE and PUBLISH its output (a page, graph, file, image). If a step needs a capability that is NOT in your scope above, do NOT silently give up or fake it — call `requestAccess({ power, why })` (always available) so the owner can grant it, then tell the user you have requested it and what you will do once granted. A capability you reference but were not granted will throw "is not defined"; that means you must requestAccess for it, not work around it.',
    'PROPOSE FREELY, IN PARALLEL, AND CONTINUOUSLY: a single response MAY launch MANY sub-agents and proposals — call delegateTask/employ/proposeSpawnSpecialist/proposeTool several times in one program; do not artificially stop at one. Give each delegate/specialist you create a MEMORABLE, HUMAN pet name (the `nickname` arg) — a short evocative two-word name like "Cobalt Otter" or "Scandinavian Airline Agent", NEVER a code or id — so it reads nicely in the chat/trace and as the proposer of anything it builds. (If you omit one, a friendly pet name is auto-assigned — but you naming it is better.) When you are processing an ONGOING or STREAMING feed of information (a live multi-speaker transcript, a wearable\'s audio stream, a long document arriving in pieces), stay in a continuously-helpful posture: surface AS MANY genuinely useful, well-scoped suggestions/delegations/proposals as the available information supports — each nicknamed — rather than a single summary, and keep doing so as new information arrives.',
    'END YOUR TURN by calling exactly ONE of (always in scope, alongside methodsOf/requestAccess): `answer("<reply>")` when the task is complete; `ask("<question>")` when you need ONE thing from the user to proceed; `blocked("<what you did, what you could not, and why>")` when you could not finish (e.g. a capability you had to requestAccess for). Call it as the LAST thing your program does.',
    'ALWAYS finish by calling one of answer()/ask()/blocked() — NEVER end silently or with an empty reply. If something failed or a capability was missing, use `blocked(...)` with a clear "here is what I did and what stopped me"; going quiet is a bug.',
    'KEEP THE USER POSTED ON LONG TASKS: if your work will take more than a few seconds — several tool calls, a research pass, building something, a multi-phase plan — call `updateProgress("<one line of what you are doing now>")` at the START of each phase (e.g. before research, before comparing, before publishing). It shows live in the UI and does NOT end your turn, so the page never looks frozen while you work. It is for status only; still finish with answer()/ask()/blocked().',
  ].filter(Boolean).join('\n');
  // the full system prompt is now assembled — expose it read-only so the program can pass slices to delegates.
  endow.mySystemPrompt = harden(sys);

  const uc = buildUserContent ? buildUserContent(userText, attachments) : String(userText || '');
  // RESUME: if a saved in-flight transcript is handed in (after a top-up), CONTINUE from it — re-using all the
  // prior reasoning + tool OUTPUTs — instead of rebuilding the turn from scratch and re-running everything. The
  // system prompt is rebuilt fresh (so the budget line shows the topped-up balance); after it sits the saved
  // transcript, which already ends on a user/OUTPUT turn, so the next invoke() just carries on.
  const messages = (Array.isArray(resumeMessages) && resumeMessages.length)
    ? [{ role: 'system', content: sys }, ...resumeMessages]
    : [{ role: 'system', content: sys }, ...history, { role: 'user', content: uc }];
  const cancelled = () => { onStep({ kind: 'cancelled' }); return harden({ answer: '', toolsUsed: used, cancelled: true }); };

  // FAILURES MUST BE LEGIBLE: an agent that gets stuck (no value, a missing capability, a repeating
  // error) must SAY SO in the chat — never go silent. Build a plain-language explanation from what it
  // actually did, so the user (and the trace) sees a real message instead of an empty bubble.
  const stallMessage = lastError => {
    const reqs = [...new Set(used.filter(u => u.name === 'requestAccess').map(u => u.args && u.args.power).filter(Boolean))];
    if (reqs.length) return `I can't finish this yet — it needs the ${reqs.join(' and ')} capability, which I don't currently hold. I've asked the owner to grant it. Once it's granted, ask me again and I'll complete the task.`;
    if (lastError) return `I wasn't able to complete this. My last step failed with: ${lastError}. This often means I'm missing a capability the task needs — tell me how you'd like to proceed, or grant the access and I'll continue.`;
    return `I wasn't able to produce a result for this. Could you tell me a bit more about what you need, or rephrase the request?`;
  };

  // No step limit: the agent iterates until it ANSWERs, is ABORTED, or the prepaid ALLOWANCE METER
  // is exhausted. Every iteration makes a metered LLM call, so the purse bounds the loop elegantly —
  // legitimate long tasks are never cut off by an arbitrary count; spend is the real budget.
  let lastError = '';
  let repeatErr = 0; // consecutive identical throws → the agent is wedged; break out and REPORT it
  let failStreak = 0; // consecutive throws of ANY kind → catches alternating/non-identical errors repeatErr misses
  let emptyRetries = 0; // the model returned NOTHING (no program, no answer) → nudge it to act, then report honestly
  let syntaxRetries = 0; // P1-7(a): the generated program failed to PARSE → feed the error back and retry ONCE
  let round = 0;
  for (;;) {
    if (signal?.aborted) return cancelled();
    // HEARTBEAT before the (potentially slow) LLM call: the FIRST program a model writes for a big task can take
    // a minute+ to generate, during which no tool has run → zero trace events → the page looks DEAD. Emit a
    // lightweight thinking ping at each round so the UI can show "Thinking…" immediately, before any tool fires.
    round += 1; try { onStep({ kind: 'thinking', round }); } catch { /* heartbeat is best-effort */ }
    // MID-TURN INTERJECTION: re-steer a long fan-out WITHOUT aborting it. Anything the user posted since the
    // last round is folded into context HERE, at the step boundary, so the next program sees it. takeInterjections
    // DRAINS (once-only); a turn with none injected is byte-identical to before (default is () => []).
    try {
      const inj = takeInterjections() || [];
      if (inj.length) { messages.push({ role: 'user', content: `[the user interjected mid-turn — take this into account in what you do next]\n${inj.join('\n')}` }); onStep({ kind: 'interjection', text: inj.join('\n') }); }
    } catch { /* an interjection source must never break the loop */ }
    // REL-3: the "callLLM never throws" invariant is now ENFORCED here, not merely assumed. A provider
    // fetch that rejects (network reset, a throw inside a BYO key path, a metered-LLM edge) would
    // otherwise escape the loop as a rejection → the /chat Promise.race rejects → (pre-REL-1) the
    // plaintext outer catch + a stuck 'running' run. Turn ANY throw into the same structured llmError
    // the {error} return already produces (retryable, never persisted as the agent's reply).
    let out;
    try { out = await invoke(messages, model); }
    catch (e) {
      const msg = (e && e.message) || String(e);
      onStep({ kind: 'tool-error', name: 'model', error: msg });
      return harden({ answer: '', toolsUsed: used, llmError: msg });
    }
    // Even out-of-allowance is legible: hand back a clear note (the server still flags `exhausted`).
    // Hand back the in-flight transcript (minus the system prompt) so a top-up can RESUME exactly here —
    // continuing the reasoning rather than re-running every prior step.
    if (out && out.exhausted) return harden({ answer: stallMessage(lastError) + ' (The prepaid allowance for this chat is also used up.)', toolsUsed: used, exhausted: true, remaining: out.remaining, resumeFrom: messages.slice(1) });
    // PROVIDER ERROR (e.g. a 429/overload/unreachable) → a RETRYABLE failure, NOT an answer. Returning it
    // as `llmError` keeps it from being persisted as the agent's reply (the bug where an Opus 429 string
    // became a permanent chat bubble that retrying couldn't clear). The client shows a transient retry card.
    if (out && out.error) { onStep({ kind: 'tool-error', name: 'model', error: out.error }); return harden({ answer: '', toolsUsed: used, llmError: out.error }); }
    if (signal?.aborted) return cancelled();
    const reply = (out && out.text) || '';
    const code = extractCode(reply);
    if (!code) {
      // No ```js program in the reply. A turn ENDS via a turn-ender FUNCTION (answer/ask/blocked); the `ANSWER:`
      // text MARKER is RETIRED — it is no longer emitted, parsed, or stripped (the last in-band control marker).
      // (1) a bare turn-ender call emitted WITHOUT a ```js fence (a weaker model slip) → accept it AS that
      //     function, preserving its KIND so ask()/blocked() keep their structured flag — it's a function call,
      //     not a marker.
      const bare = /^\s*(answer|ask|blocked)\(\s*(['"`])([\s\S]*)\2\s*\)\s*;?\s*$/i.exec(reply);
      if (bare) {
        const kind = bare[1].toLowerCase();
        // P1-7(b): even an unfenced bare turn-ender goes through the answer-channel lint (a raw program/blob
        // wrapped in answer(...) must not surface verbatim).
        let text = answerHygiene(bare[3]);
        // P1-3: an empty bare turn-ender (e.g. `answer("")`) is a STALL, not a reply — report it as blocked
        // (research handoffs are intentionally empty and are not emitted as a bare unfenced call).
        let flag = kind;
        if (!String(text == null ? '' : text).trim()) { text = '(the agent ended its turn without a message)'; flag = 'blocked'; }
        onStep({ kind: 'answer', text });
        return harden({ answer: text, toolsUsed: used, ...(flag === 'ask' ? { asking: true } : flag === 'blocked' ? { blocked: true } : flag === 'research' ? { researching: true } : {}) });
      }
      // (2) a non-empty natural-language reply → deliver it as the answer. A model replying in prose IS its reply;
      //     there is no marker to parse. (3) empty → a MODEL stall: nudge it to ACT + end with a turn-ender
      //     (bounded), then report honestly. Never go silent.
      let answer = reply.trim();
      if (!answer) {
        if (emptyRetries < 2 && !signal?.aborted) {
          emptyRetries += 1;
          onStep({ kind: 'tool-error', name: 'model', error: 'empty response — nudging to act + end with a turn-ender' });
          messages.push({ role: 'user', content: 'You returned an empty response. Use the conversation ABOVE for context (e.g. a device/object/peer already identified earlier in this chat — refer to it directly), then reply with a ```js program that DOES the task and ENDS by calling exactly one turn-ender: answer("…") when done, ask("…") if you need one thing from the user, or blocked("…") if you could not finish. Do not return nothing.' });
          continue;
        }
        answer = lastError ? stallMessage(lastError)
          : 'The model returned an empty response for this — that usually means the current model (the local default) stalled on a multi-step request, not that anything is unclear. Try again, or switch to a stronger model (the Claude options in the header) for this kind of follow-up action.';
      } else {
        // P1-7(b): the reply is prose (no fenced program was extracted). Guard the channel: a raw provider-error
        // blob, a stray unfenced program, or a whole ```block dumped as prose must not be delivered verbatim.
        answer = answerHygiene(answer);
      }
      onStep({ kind: 'answer', text: answer });
      return harden({ answer, toolsUsed: used });
    }
    messages.push({ role: 'assistant', content: reply });
    onStep({ kind: 'code', code });
    const r = await runProgram(code, endow);
    if (signal?.aborted) return cancelled();
    // The program called answer()/ask()/blocked() → that IS the turn's reply, delivered as a scope function (not
    // parsed from prose). Return it BEFORE touching r.ok/r.error: the sentinel unwind shows up as a program
    // "throw", but the captured finalReply supersedes it. (A program that set the reply then hit a real error
    // still delivers it — better than going silent.) The kind rides along as a structured asking/blocked flag.
    if (finalReply != null) { const { kind, text, objects } = finalReply; onStep({ kind: 'answer', text, ...(objects && objects.length ? { objects } : {}) }); return harden({ answer: text, toolsUsed: used, ...(objects && objects.length ? { objects } : {}), ...(kind === 'ask' ? { asking: true } : kind === 'blocked' ? { blocked: true } : kind === 'research' ? { researching: true } : {}) }); }
    // REL-3: a metered sub-call (delegateTask) refused for lack of allowance (re-thrown from wrapCall) →
    // surface the WHOLE turn as EXHAUSTED so the client shows the deterministic top-up card, handing back
    // the in-flight transcript so a top-up RESUMES here rather than re-running the delegation.
    if (!r.ok && /INFERENCE_BUDGET_EXHAUSTED/.test(String(r.error || ''))) {
      onStep({ kind: 'tool-error', name: 'model', error: r.error });
      return harden({ answer: stallMessage(lastError) + ' (The prepaid allowance for this chat is used up.)', toolsUsed: used, exhausted: true, resumeFrom: messages.slice(1) });
    }
    // P1-7(a): the generated PROGRAM did not PARSE (SyntaxError — a truncated/cut-off program, an unbalanced
    // brace/quote/fence). Do NOT surface the raw SyntaxError as the turn result (nor let it feed the failStreak
    // stall as raw error text): AUTO-RETRY the program-generation ONCE with the parse error fed back so the model
    // can fix/resend. If it STILL doesn't parse, stop and return a clean `blocked` stall — never the raw error.
    if (!r.ok && r.syntax) {
      onStep({ kind: 'tool-error', name: 'model', error: `program did not parse: ${r.error}` });
      if (syntaxRetries < 1 && !signal?.aborted) {
        syntaxRetries += 1;
        messages.push({ role: 'user', content: `Your program did not PARSE (SyntaxError: ${clip(r.error, 400)}). It was likely cut off or has an unbalanced brace/quote/fence. Re-send a COMPLETE, SHORTER \`\`\`js program that parses cleanly — close every brace and the \`\`\` fence — and end by calling exactly one turn-ender: answer("…"), ask("…"), or blocked("…").` });
        continue;
      }
      const answer = "I couldn't complete this — the step I tried to run didn't parse as a valid program, even after a retry. Could you rephrase or narrow the request and I'll try again?";
      onStep({ kind: 'answer', text: answer });
      return harden({ answer, toolsUsed: used, blocked: true, stalled: true });
    }
    const parts = [];
    if (r.logs.length) parts.push(`logs:\n${clip(r.logs.join('\n'), 8000)}`);
    if (r.ok) { parts.push(`returned: ${clip(safeJson(r.value), 12000)}`); repeatErr = 0; failStreak = 0; lastError = ''; }
    else {
      // USEFUL ERROR when the agent INVENTS a tool: a bare "X is not defined" becomes a clear message —
      // what tools actually exist, and how to ask for a real capability you lack (requestAccess) — so the
      // model stops re-calling a hallucinated name. (Only the program scope `endow` knows what's real.)
      let err = String(r.error || '');
      const undef = /^(?:Uncaught )?ReferenceError: (\w[\w$]*) is not defined|^(\w[\w$]*) is not defined/.exec(err);
      const bad = undef && (undef[1] || undef[2]);
      if (bad) {
        const helpers = new Set(['methodsOf', 'myPersona', 'mySystemPrompt', 'requestAccess', 'answer', 'ask', 'blocked', 'updateProgress', 'console']);
        const real = Object.keys(endow).filter(k => !helpers.has(k)).sort();
        err = `no tool named "${bad}" — you invented it; it is not in scope. Your ACTUAL tools are: ${real.join(', ') || '(none)'}. `
          + `If "${bad}" is a real capability you need but don't have, call requestAccess({ power: "${bad}", why: "…" }) ONCE — do not keep calling "${bad}". `
          + `(Also always in scope: methodsOf, myPersona, mySystemPrompt, requestAccess.)`;
      }
      parts.push(`threw: ${err}`);
      repeatErr = err === lastError ? repeatErr + 1 : 0; lastError = err;
      failStreak += 1;
      // Wedged: the same error 3× running and still no answer → stop burning allowance, REPORT the failure.
      if (repeatErr >= 2) { const answer = stallMessage(lastError); onStep({ kind: 'answer', text: answer }); return harden({ answer, toolsUsed: used, stalled: true }); }
      // Also wedged when errors DIFFER each turn (so repeatErr never climbs): a run of 4 failures in a row
      // means no forward progress → stop burning allowance, REPORT the last failure honestly.
      if (failStreak >= 4) { const answer = stallMessage(lastError); onStep({ kind: 'answer', text: answer }); return harden({ answer, toolsUsed: used, stalled: true }); }
    }
    // TRAJECTORY CRITIC HOOK: after each program result, emit a lightweight non-control-flow event so
    // observers can SCORE progress (e.g. detect a stalling trajectory) from the running counters —
    // failStreak / repeatErr / lastError — WITHOUT altering the loop. Purely observational: ignore the
    // return value; never let an onStep throw break the agent (the loop's own guards still decide control flow).
    try { onStep({ kind: 'trajectory', failStreak, repeatErr, lastError }); } catch { /* observers must not break the loop */ }
    messages.push({ role: 'user', content: `OUTPUT:\n${parts.join('\n')}` });
    // P1-5 STEP-BOUNDARY PERSIST: a tool (or several) just executed and its OUTPUT is now in the transcript. Save
    // the accumulating transcript-with-outputs durably (excluding the system prompt — the server re-adds a fresh
    // one on resume, exactly as the in-process top-up path does). On a mid-turn restart the recovery path loads
    // THIS as resumeMessages, so the replayed program SEES the prior tool OUTPUTs and does NOT re-invoke them —
    // recovery becomes a replay, not a re-fire. Best-effort: a persist failure must never break the turn.
    if (persistTranscript) { try { persistTranscript(messages.slice(1)); } catch { /* durable persist is best-effort */ } }
  }
};
harden(runAgentCode);
