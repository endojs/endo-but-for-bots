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
// Drop-in alongside runAgent: same signature, so /chat can pick either loop.
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
  // Endowments become the Compartment's globals. The cap fns close over host authority — that IS
  // the authority bridge; nothing else (no process/require/fs/import) is reachable from inside.
  const compartment = new Compartment(harden({ ...endow, console: con }));
  try {
    // wrap as an async IIFE so the program may `await` caps and `return` a value
    const value = await compartment.evaluate(`(async () => {\n${String(code)}\n})()`);
    return { ok: true, value, logs };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), logs };
  }
};

const safeJson = v => { try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)); } catch { return String(v); } };
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)}…[${t.length - n} more chars]` : t; };

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

export const runAgentCode = async ({ toolbox, manifest, userText, history = [], onStep = () => {}, signal, persona = '', attachments = [], model = 'default', llm, budgetLine = '', callLLM = defaultCallLLM, buildUserContent = defaultBuildUserContent } = {}) => {
  const invoke = llm || callLLM;
  const used = [];
  // Wrap every toolbox verb as an async fn the program can call: `await name(args)`. Each emits the
  // same onStep events as the classic loop, so the trace/pendant + toolsUsed keep working.
  // wrap one invocation so it emits the trace + records usage + never throws past the sandbox.
  const wrapCall = (label, fn) => harden(async (args = {}) => {
    if (signal?.aborted) throw new Error('aborted');
    onStep({ kind: 'tool-start', name: label, args });
    try { const r = await fn(args || {}); used.push({ name: label, args, result: r }); onStep({ kind: 'tool', name: label, args, result: r }); return r; }
    catch (e) { onStep({ kind: 'tool-error', name: label, error: (e && e.message) || String(e) }); return harden({ ok: false, error: (e && e.message) || String(e) }); }
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
  const api = apiLines.join('\n');
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
    '',
    'HOW TO ACT — reply with a single fenced JavaScript program:',
    '```js',
    '// compose freely: call multiple capabilities, loop, branch, use the results',
    "const hits = await searchNotes({ query: 'budget' });",
    'return hits;   // `return` your result (or console.log intermediate values)',
    '```',
    'The program runs in a SECURE SANDBOX: only the capabilities above + console + methodsOf exist. There is no filesystem, network, process, or import — only your granted capabilities. `await` any capability call. `return` a value to inspect it (you will see it as OUTPUT), or `console.log(...)` to trace.',
    'BIAS TO ACTION: prefer few, well-composed programs over many round-trips — BUT keep each program SHORT enough to finish in one reply (always close the ``` fence). If a task is large, do it across several smaller programs (gather → inspect OUTPUT → act), not one giant block. After OUTPUT, write another program or give your final reply on one line prefixed with `ANSWER:`.',
    'USE THE BREADTH OF YOUR TOOLKIT — the strongest results come from distributing work ACROSS the capabilities you hold and composing them, not fixating on one or two. And act with PRECISION: prefer specific, targeted moves (the exact note, the exact device, the precise parameter/recipient) over broad, coarse ones.',
    'PLAN FIRST, THEN ACT: before you start, think through every step the task needs end to end — INCLUDING how you will PRODUCE and PUBLISH its output (a page, graph, file, image). If a step needs a capability that is NOT in your scope above, do NOT silently give up or fake it — call `requestAccess({ power, why })` (always available) so the owner can grant it, then tell the user you have requested it and what you will do once granted. A capability you reference but were not granted will throw "is not defined"; that means you must requestAccess for it, not work around it.',
    'PROPOSE FREELY, IN PARALLEL, AND CONTINUOUSLY: a single response MAY launch MANY sub-agents and proposals — call delegateTask/employ/proposeSpawnSpecialist/proposeTool several times in one program; do not artificially stop at one. NICKNAME each delegate/specialist you create (the `nickname` arg) so it is readable in the trace and as the proposer of anything it builds. When you are processing an ONGOING or STREAMING feed of information (a live multi-speaker transcript, a wearable\'s audio stream, a long document arriving in pieces), stay in a continuously-helpful posture: surface AS MANY genuinely useful, well-scoped suggestions/delegations/proposals as the available information supports — each nicknamed — rather than a single summary, and keep doing so as new information arrives.',
    'When the task is complete, reply with `ANSWER: <your concise reply to the user>` (no code block).',
    'ALWAYS finish with an `ANSWER:` line — even if you were BLOCKED or something FAILED. Never end silently or with an empty reply. If you could not finish, say plainly what you accomplished, what you could not, and why (e.g. a capability you had to requestAccess for). A clear "here is what stopped me" is required; going quiet is a bug.',
  ].filter(Boolean).join('\n');

  const uc = buildUserContent ? buildUserContent(userText, attachments) : String(userText || '');
  const messages = [{ role: 'system', content: sys }, ...history, { role: 'user', content: uc }];
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
  for (;;) {
    if (signal?.aborted) return cancelled();
    const out = await invoke(messages, model);
    // Even out-of-allowance is legible: hand back a clear note (the server still flags `exhausted`).
    if (out && out.exhausted) return harden({ answer: stallMessage(lastError) + ' (The prepaid allowance for this chat is also used up.)', toolsUsed: used, exhausted: true, remaining: out.remaining });
    if (signal?.aborted) return cancelled();
    const reply = (out && out.text) || '';
    const code = extractCode(reply);
    if (!code) { // no program → treat as the final answer; if it's empty, explain the stall instead of going silent
      let answer = reply.replace(/^ANSWER:\s*/i, '').trim();
      if (!answer) answer = stallMessage(lastError);
      onStep({ kind: 'answer', text: answer });
      return harden({ answer, toolsUsed: used });
    }
    messages.push({ role: 'assistant', content: reply });
    onStep({ kind: 'code', code });
    const r = await runProgram(code, endow);
    if (signal?.aborted) return cancelled();
    const parts = [];
    if (r.logs.length) parts.push(`logs:\n${clip(r.logs.join('\n'), 8000)}`);
    if (r.ok) { parts.push(`returned: ${clip(safeJson(r.value), 12000)}`); repeatErr = 0; lastError = ''; }
    else {
      parts.push(`threw: ${r.error}`);
      repeatErr = r.error === lastError ? repeatErr + 1 : 0; lastError = r.error;
      // Wedged: the same error 3× running and still no answer → stop burning allowance, REPORT the failure.
      if (repeatErr >= 2) { const answer = stallMessage(lastError); onStep({ kind: 'answer', text: answer }); return harden({ answer, toolsUsed: used, stalled: true }); }
    }
    messages.push({ role: 'user', content: `OUTPUT:\n${parts.join('\n')}` });
  }
};
harden(runAgentCode);
