/* global process */
import { fileURLToPath } from 'url';
import path from 'path';
// eslint-disable-next-line import/no-unresolved
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { makeEndoPlugin } from './vite-endo-plugin.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [makeEndoPlugin(), react()],
  base: './',
  resolve: {
    alias: {
      // `@endo/platform/fs/extended` reaches `node:crypto` through its content-
      // addressed snapshot helper. Vite aliases `node:crypto` to @endo/sha256's
      // browser build (pure-JS sync SHA-256) so the explorer's bundle builds
      // without pulling a Node polyfill.
      'node:crypto': path.resolve(__dirname, '../sha256/sha256-browser.js'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: './index.html',
      },
    },
  },
  server: {
    port: process.env.VITE_PORT ? Number(process.env.VITE_PORT) : 5173,
    strictPort: false,
    // Allow access through a reverse proxy (e.g. `tailscale serve`) that
    // forwards the tailnet hostname. Defaults to any *.ts.net MagicDNS host;
    // override with a comma-separated VITE_ALLOWED_HOSTS.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',')
      : ['.ts.net'],
  },
});
