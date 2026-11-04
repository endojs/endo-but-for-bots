// @ts-check
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    sourcemap: true,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: { counter: 'counter-app/index.html', runtime: 'src/browser.js' },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
      onwarn(warning, warn) {
        if (
          warning.code === 'UNRESOLVED_IMPORT' ||
          warning.message.includes('externalized for browser')
        )
          throw new Error(warning.message);
        warn(warning);
      },
    },
  },
});
