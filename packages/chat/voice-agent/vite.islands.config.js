// Vite build for the confined-Preact ISLANDS bundle.
//
// The voice-agent client is (still) a hand-written DOM app served statically from public/. This build
// produces ONE additional ES bundle — public/islands/islands.js — that the existing index.html loads
// alongside app.js. It bundles preact + @endo/preact-container + the ses assert-shim so the islands can
// render through the SANITIZING renderer (renderConfined). The DOM app and the islands coexist; we
// migrate one slice at a time (see designs/preact-component-trie.md). No lockdown() is called here —
// Phase 1 renders our OWN (trusted) components through the sanitizing path; untrusted-source
// confinement (confineComponent + severe-taming lockdown) arrives with the per-component agents.
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Our node server owns public/ — Vite must not treat it as a copy-source (outDir lives inside it).
  publicDir: false,
  build: {
    outDir: 'public/islands',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('./client/islands.js', import.meta.url)),
      formats: ['es'],
      fileName: () => 'islands.js',
    },
  },
});
