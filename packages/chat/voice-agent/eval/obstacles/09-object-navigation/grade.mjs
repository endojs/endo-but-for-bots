// grade.mjs — Obstacle 09: navigating a NEW / unfamiliar Endo object.
//
// Guards the failure dan hit: he accepted a Kumavis invite and the agent didn't understand how to use the
// object or even introspect it — even though Endo objects are self-documenting. This obstacle asserts the
// agent's ONBOARDING CONTEXT (the assembled system prompt + the `objects`-power tool descriptions) actually
// TEACHES the navigation: listObjects → callObject(name,'describe'/'help') to discover methods → call them,
// rather than giving up. Deterministic: a fake llm captures the REAL assembled system prompt (no live model),
// and the cap mechanics use the real field-agent (no network). (roadmap §6; the self-documenting-object gap.)
import '@endo/init';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFieldAgent } from '../../../agent-caps.mjs';
import { runAgentCode } from '../../../../../ocapn-noise/codemode.mjs';

export const meta = harden({ id: '09-object-navigation', theme: 'objects', llm: false });

export const grade = async () => {
  const checks = [];
  const ok = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail: String(detail) }); };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-objnav-'));
  process.env.OBJECTS_FILE = path.join(outDir, 'objects.json'); // isolate the inventory from the real store
  try {
    const fa = makeFieldAgent({ outDir, baseUrl: 'http://localhost:0', autoConfirmFile: path.join(outDir, 'a.json'), specialistsFile: path.join(outDir, 's.json') });
    const { toolbox, manifest } = fa.rootNode.toolbox();
    const verb = n => manifest.find(m => m.name === n);

    // 1. The objects power + its navigation verbs are present.
    ok('objects power present (proposeAcceptInvite/listObjects/callObject)', !!verb('proposeAcceptInvite') && !!verb('listObjects') && !!verb('callObject'));

    // 2. Its tool descriptions TEACH self-documenting navigation (describe/help to discover methods first).
    const cap = (verb('callObject')?.description || '').toLowerCase();
    ok('callObject teaches describe/help introspection', /describe|help/.test(cap) && /self-documenting|introspect|discover/.test(cap), cap.slice(0, 90));
    ok('callObject.method arg hint mentions describe', /describe/i.test(verb('callObject')?.args?.method || ''));
    ok('listObjects frames objects as self-documenting', /self-documenting|describe|help/i.test(verb('listObjects')?.description || ''));

    // 3. The ASSEMBLED SYSTEM PROMPT the agent actually sees teaches it (captured via a fake llm — deterministic).
    let sys = '';
    const llm = async messages => { sys = (messages[0] && messages[0].content) || ''; return { text: 'ANSWER: ok' }; };
    await runAgentCode({ toolbox, manifest, userText: 'hello', llm, buildUserContent: t => String(t || '') });
    const s = sys.toLowerCase();
    ok('system prompt teaches self-documenting objects + introspect-first', /self-documenting/.test(s) && /describe/.test(s) && (/introspect/.test(s) || /never .*unusable|do not give up|ask it what/.test(s)), `${sys.length} chars`);
    ok('system prompt names the listObjects→callObject path', /listobjects/.test(s) && /callobject/.test(s));

    // 4. The Kumavis case end-to-end: a just-accepted iroh ref is held + CALLABLE, and introspecting an
    //    unreachable one fails LEGIBLY (an iroh dial error), never the cryptic null/rpc.
    const p = await toolbox.proposeAcceptInvite.run({ link: `iroh://navpeernode/permissions#cap=${'a'.repeat(32)}`, name: 'NavPeer', description: 'a newly-introduced peer' });
    await fa.commitProposal(p.id);
    const np = (await toolbox.listObjects.run({})).objects.find(o => o.name === 'NavPeer');
    ok('accepted Endo object lands in the inventory, marked callable', !!np && np.callable === true);
    const r = await toolbox.callObject.run({ name: 'NavPeer', method: 'describe', args: [] });
    ok('introspecting an unreachable object fails legibly (iroh), never null/rpc', r.ok === false && /iroh/i.test(r.error || '') && !/null\/rpc|Failed to parse URL/.test(r.error || ''));
  } catch (e) {
    ok('obstacle ran without throwing', false, e && e.message);
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const passed = checks.every(c => c.pass);
  return harden({ passed, checks });
};
harden(grade);
