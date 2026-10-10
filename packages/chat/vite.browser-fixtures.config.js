// eslint-disable-next-line import/no-unresolved
import { defineConfig } from 'vite';

// Builds the browser-test fixture pages under test/browser/ into
// test/browser/dist/, which browser-test/server.js serves at
// /chat-fixtures/.  See test/browser/README.md.
export default defineConfig({
  root: 'test/browser',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'command-messages': 'test/browser/command-messages.html',
      },
    },
  },
});
