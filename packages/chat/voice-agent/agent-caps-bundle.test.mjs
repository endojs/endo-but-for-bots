// agent-caps-bundle.test.mjs — proves the ocap invariant for makeCapabilityBundle:
// designation by REFERENCE. A bundle holds Far power refs by petname; attenuate
// returns a structural SUBSET that can never fabricate an absent ref. POWERS /
// META_POWERS stay display-only metadata that confer no authority.
//
// The factory lives in agent-caps.mjs (re-exported) but is implemented in the
// dependency-free sibling agent-caps-bundle.mjs so this permission-core proof
// runs without the agent's heavy I/O affordance imports.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Far } from '@endo/marshal';
import { makeCapabilityBundle } from './agent-caps-bundle.mjs';

// stand-in Far power refs (identity is what matters for the subset proof)
const webRef = Far('Web', { help: () => 'web' });
const notesRef = Far('Notes', { help: () => 'notes' });
const imagesRef = Far('Images', { help: () => 'images' });

test('attenuate(superset) equals own refs', () => {
  const bundle = makeCapabilityBundle({ web: webRef, notes: notesRef });
  // request a SUPERSET (extra petnames the bundle does not hold)
  const sub = bundle.attenuate(['web', 'notes', 'images', 'host', 'feed']);
  // the attenuated bundle is EXACTLY the bundle's OWN refs — no more, no less
  assert.deepEqual([...sub.names()].sort(), [...bundle.names()].sort());
  assert.deepEqual([...sub.names()].sort(), ['notes', 'web']);
  // identity-equal: the SAME Far refs, not copies
  assert.equal(sub.get('web'), webRef);
  assert.equal(sub.get('notes'), notesRef);
  // the extra requested names were dropped, not fabricated
  assert.equal(sub.has('images'), false);
  assert.equal(sub.get('images'), undefined);
});

test('a bundle cannot name an absent ref', () => {
  const bundle = makeCapabilityBundle({ web: webRef });
  assert.equal(bundle.has('web'), true);
  assert.equal(bundle.has('notes'), false);
  // get() of an unheld petname yields undefined — no fabrication
  assert.equal(bundle.get('notes'), undefined);
  assert.equal(bundle.get('host'), undefined);
  // attenuating toward refs it does not hold yields an EMPTY bundle
  const tryNotes = bundle.attenuate(['notes', 'images', 'host']);
  assert.deepEqual(tryNotes.names(), []);
  assert.equal(tryNotes.has('notes'), false);
  assert.equal(tryNotes.get('notes'), undefined);
});

test('undefined/null refs are never carried into the bundle', () => {
  // even if a caller passes a petname with an absent ref, it is NOT held
  const bundle = makeCapabilityBundle({ web: webRef, notes: undefined, host: null });
  assert.deepEqual([...bundle.names()].sort(), ['web']);
  assert.equal(bundle.has('notes'), false);
  assert.equal(bundle.has('host'), false);
});

test('attenuation is monotonic — a sub-bundle can never re-grow', () => {
  const root = makeCapabilityBundle({ web: webRef, notes: notesRef, images: imagesRef });
  const sub = root.attenuate(['web', 'notes']);
  // sub cannot reach back to the parent's images ref via ANY name
  const tryRegrow = sub.attenuate(['web', 'notes', 'images']);
  assert.deepEqual([...tryRegrow.names()].sort(), ['notes', 'web']);
  assert.equal(tryRegrow.has('images'), false);
  assert.equal(tryRegrow.get('images'), undefined);
});

test('a display-only name list confers no authority', () => {
  // Petnames alone (as POWERS/META_POWERS keys are) are display-only: building a
  // bundle from names with NO real refs holds NOTHING — authority is the ref.
  const DISPLAY_ONLY_NAMES = ['notes', 'web', 'images', 'host', 'feed', 'subagent'];
  const fromNamesOnly = makeCapabilityBundle(
    Object.fromEntries(DISPLAY_ONLY_NAMES.map(n => [n, undefined])),
  );
  assert.deepEqual(fromNamesOnly.names(), []);
  for (const n of DISPLAY_ONLY_NAMES) assert.equal(fromNamesOnly.has(n), false);
});
