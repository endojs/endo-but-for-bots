// native-endo-objects.test.mjs — the agent tool stack is NATIVE Endo CodeMode: an accepted inventory object is
// a LIVE in-scope object the agent calls by PROPERTY ACCESS (await Kumavis.send('hi')), never by a method-name
// STRING (callObject(name,'method',args)). This is the adversarial reviewer dan asked for: it FAILS if the
// agent-facing surface regresses to string-method-dispatch as the way to call a known object. (callObject
// survives only as the introspection fallback for not-yet-described objects.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@endo/init';
import { makeFieldAgent } from './agent-caps.mjs';
import { runAgentCode } from '../../ocapn-noise/codemode.mjs';

const mk = objs => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-'));
  process.env.OBJECTS_FILE = path.join(out, 'o.json');
  fs.writeFileSync(process.env.OBJECTS_FILE, JSON.stringify({ objects: objs }));
  return makeFieldAgent({ outDir: out, baseUrl: 'http://test.invalid' });
};
const promptFor = async fa => {
  const { toolbox, manifest } = fa.rootNode.toolbox();
  let sys = '';
  await runAgentCode({ toolbox, manifest, userText: 'hi', llm: async m => { sys = m[0].content; return { text: 'ok' }; }, buildUserContent: t => String(t || '') });
  return { toolbox, manifest, sys };
};

test('a callable accepted object is a LIVE in-scope presence with method functions (not a data record + callObject)', async () => {
  const fa = mk([{ name: 'Kumavis', transport: 'endo-peer', peer: true, description: 'a peer', methods: ['send', 'inbox', 'describe'] }]);
  const { toolbox, manifest } = await promptFor(fa);
  assert.equal(typeof toolbox.Kumavis, 'object', 'bound in scope as an object');
  assert.equal(typeof toolbox.Kumavis.send, 'function', 'its methods are functions you call by property access');
  const m = manifest.find(x => x.name === 'Kumavis');
  assert.ok(m && Array.isArray(m.methods) && m.methods.some(x => x.name === 'send'), 'manifest entry carries methods[] → codemode renders it as a live object');
});

test('the assembled prompt teaches DIRECT method calls (await Name.method), forbidding string-method dispatch', async () => {
  const { sys } = await promptFor(mk([{ name: 'Kumavis', transport: 'endo-peer', peer: true, description: 'a peer', methods: ['send', 'inbox', 'describe'] }]));
  assert.match(sys, /const Kumavis = <live object/, 'the object is presented as a live in-scope object');
  assert.match(sys, /await Kumavis\.send/, 'its methods are shown called directly by property access');
  assert.match(sys, /never by a method-name string/i, 'the guidance explicitly forbids method-name strings');
  assert.match(sys, /CALL THEM DIRECTLY/, 'objects-you-hold are called directly');
});

test('ADVERSARIAL: the guidance steers OFF string-method dispatch for in-scope objects', async () => {
  const { sys } = await promptFor(mk([{ name: 'Kumavis', transport: 'endo-peer', peer: true, methods: ['send', 'inbox', 'describe'] }]));
  // The native-style guidance must be present AND it must explicitly tell the agent NOT to callObject an
  // object that's already in scope — so callObject is framed as the describe/introspection fallback only. If
  // a future change drops this steer (or re-promotes callObject(name,'send') as the call path), this fails.
  assert.match(sys, /Do NOT write[^\n]*callObject[^\n]*already in scope/i, 'explicitly forbids callObject for an in-scope object');
  // and the only callObject the guidance positively endorses is for introspecting a not-yet-described object
  assert.match(sys, /callObject\(name, "describe"\)[^\n]*introspect/i, 'callObject is framed as the describe/introspection fallback');
});
