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

export const runAgentCode = async ({ toolbox, manifest, userText, history = [], onStep = () => {}, signal, persona = '', attachments = [], model = 'default', llm, budgetLine = '', resumeMessages = null, callLLM = defaultCallLLM, buildUserContent = defaultBuildUserContent, takeInterjections = () => [] } = {}) => {
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
  let finalReply = null; // { kind: 'answer'|'ask'|'blocked', text }
  const REPLY_SENTINEL = '__codemode_reply__';
  const endTurn = (kind, text) => { finalReply = { kind, text: String(text == null ? '' : text) }; throw new Error(REPLY_SENTINEL); };
  endow.answer = harden(text => endTurn('answer', text));
  endow.ask = harden(question => endTurn('ask', question));
  endow.blocked = harden(reason => endTurn('blocked', reason));
  // Expose your OWN prompt as read-only variables so you can reference it — or pass a SLICE of it as
  // context to a delegate (e.g. delegateTask({ prompt: `${myPersona}\n\n<the sub-task>` })). myPersona is
  // your operator-confirmed instructions; mySystemPrompt is your full assembled system prompt.
  endow.myPersona = harden(String(persona || ''));
  apiLines.push('  const myPersona = <string: your operator-confirmed instructions>; const mySystemPrompt = <string: your FULL system prompt>. Read-only. Reference them, or pass a slice as context to a delegate — e.g. delegateTask({ prompt: `${myPersona.slice(0, 600)}\\n\\n<sub-task>`, ... }).');
  apiLines.push('  answer(text) / ask(question) / blocked(reason): the THREE ways to END your turn (always in scope). answer(text) = task complete, here is the reply. ask(question) = you need ONE thing from the user to proceed — ask it and yield. blocked(reason) = you could not complete it — say plainly what you did, what you could not, and why. This is HOW you reply; do NOT use an "ANSWER:" text marker. `return` is only for INSPECTING an intermediate value as OUTPUT.');
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
  for (;;) {
    if (signal?.aborted) return cancelled();
    // MID-TURN INTERJECTION: re-steer a long fan-out WITHOUT aborting it. Anything the user posted since the
    // last round is folded into context HERE, at the step boundary, so the next program sees it. takeInterjections
    // DRAINS (once-only); a turn with none injected is byte-identical to before (default is () => []).
    try {
      const inj = takeInterjections() || [];
      if (inj.length) { messages.push({ role: 'user', content: `[the user interjected mid-turn — take this into account in what you do next]\n${inj.join('\n')}` }); onStep({ kind: 'interjection', text: inj.join('\n') }); }
    } catch { /* an interjection source must never break the loop */ }
    const out = await invoke(messages, model);
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
    if (!code) { // no program → BACK-COMPAT fallback: treat bare prose as the final answer (the primary path is
      // now a program that calls answer()). Strip a legacy `ANSWER:` marker if present. If it's empty, the MODEL
      // produced nothing.
      let answer = reply.replace(/^ANSWER:\s*/i, '').trim();
      // SAFETY NET: a weaker model may emit a bare `answer("…")` / `ask("…")` / `blocked("…")` call WITHOUT a
      // ```js fence (so extractCode missed it) — unwrap the string argument so the user sees the message, not the
      // literal call text. (The kind/flag is lost in this degraded path, but the text still reaches the user.)
      const bare = /^(?:answer|ask|blocked)\(\s*(['"`])([\s\S]*)\1\s*\)\s*;?$/i.exec(answer);
      if (bare) answer = bare[2];
      if (!answer) {
        // The model returned NOTHING — no program, no answer. This is a MODEL stall (common with the local
        // default on a multi-step action / follow-up), NOT the user being unclear. NUDGE it to use the
        // conversation context + act (or ask a SPECIFIC question), retrying a couple of times; only then
        // report — honestly (a model issue + the stronger-model lever), never the misleading "tell me more".
        if (emptyRetries < 2 && !signal?.aborted) {
          emptyRetries += 1;
          onStep({ kind: 'tool-error', name: 'model', error: 'empty response — nudging to use context + act' });
          messages.push({ role: 'user', content: 'You returned an empty response. Use the conversation ABOVE for context (e.g. a device/object/peer already identified earlier in this chat — refer to it directly). Then either WRITE a ```js program that uses your tools to DO the task, or ask ONE specific clarifying question, or reply by calling `answer("<text>")` in a program. Do not return nothing.' });
          continue;
        }
        answer = lastError ? stallMessage(lastError)
          : 'The model returned an empty response for this — that usually means the current model (the local default) stalled on a multi-step request, not that anything is unclear. Try again, or switch to a stronger model (the Claude options in the header) for this kind of follow-up action.';
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
    if (finalReply != null) { const { kind, text } = finalReply; onStep({ kind: 'answer', text }); return harden({ answer: text, toolsUsed: used, ...(kind === 'ask' ? { asking: true } : kind === 'blocked' ? { blocked: true } : {}) }); }
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
        const helpers = new Set(['methodsOf', 'myPersona', 'mySystemPrompt', 'requestAccess', 'answer', 'ask', 'blocked', 'console']);
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
  }
};
harden(runAgentCode);
