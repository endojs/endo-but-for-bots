// tool-bundle.mjs — real Endo bundles for shareable CLASS tools, via @endo/compartment-mapper's
// makeBundle (the engine @endo/bundle-source wraps) — used DIRECTLY so we need no extra dependency and
// no separate process: compartment-mapper resolves + runs in-process under @endo/init. A bundle is a
// portable, multi-module-capable Endo Static Module Record artifact: it carries the class's whole module
// graph, so a recipient on any Endo host can instantiate their OWN local instance from it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';

const readPowers = makeReadPowers({ fs, url, crypto });

// Path-guard a relative file name inside the throwaway package (no escaping via .. or absolute paths).
const within = (root, rel) => {
  const p = path.resolve(root, String(rel || '').replace(/^[/\\]+/, ''));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`file escapes the package: ${rel}`);
  return p;
};

// Bundle a MULTI-FILE class: `files` is { 'tool.js': source, 'helper.js': source, 'sub/x.js': … }. The
// entry (default tool.js) must `export const make`; makeBundle traces its imports across the package →
// one portable, multi-module Endo bundle (the SMR artifact). Returns the bundle string.
export const bundleFiles = async (files, entry = 'tool.js') => {
  if (!files || typeof files !== 'object' || !files[entry]) throw new Error(`files must include the entry "${entry}"`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classtool-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'class-tool', version: '0.0.0', type: 'module', main: entry }));
    for (const [rel, src] of Object.entries(files)) { const p = within(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(src ?? '')); }
    return await makeBundle(readPowers, url.pathToFileURL(within(dir, entry)).href);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
};

// Bundle a SINGLE-file class given its `make(powers)` BODY (wrapped as the entry module). Thin shim over
// bundleFiles for the common one-file case.
export const bundleMakeBody = makeBody => bundleFiles({ 'tool.js': `export const make = async (powers) => {\n${String(makeBody || '')}\n};\n` });

// Instantiate a bundle in a fresh SES Compartment endowed with `powers`, then call its `make(powers)`.
// Confined: the bundle's modules see only the compartment's globals (harden/console) + the powers we
// pass to make(). No ambient fs/process/network.
export const instantiateBundle = async (bundle, powers) => {
  const compartment = new Compartment(harden({ console: harden({ log: () => {}, error: () => {} }), harden }));
  const getExport = compartment.evaluate(String(bundle));
  const ns = typeof getExport === 'function' ? getExport(src => compartment.evaluate(src)) : getExport;
  if (!ns || typeof ns.make !== 'function') throw new Error('bundle has no exported make(powers)');
  return ns.make(powers);
};
