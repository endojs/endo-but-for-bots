module.exports = {
  // `@endo/jsdoc-import-extensions` extends the `import/extensions` policy to
  // JSDoc `@import` tags, which the `import` plugin never parses. Declaring the
  // `@endo` plugin here keeps this config self-contained when it is composed
  // into a lint run (the `@endo` plugin is otherwise declared in the
  // `recommended` config that shares the `strict` chain).
  plugins: ['@endo'],
  settings: {
    'import/resolver': {
      exports: {},
      node: {},
    },
  },
  rules: {
    'import/extensions': ['error', 'always', { ignorePackages: true }],
    // Extend the extension policy to the JSDoc `@import` surface, which neither
    // `import/extensions` nor `import/no-unresolved` parses: relative specifiers
    // must carry a file extension, and `@endo/*` subpaths must carry `.js` when
    // the target package's exports map only offers the `.js`-suffixed key.
    '@endo/jsdoc-import-extensions': 'error',
    'import/no-extraneous-dependencies': [
      'error',
      {
        devDependencies: [
          '**/*.config.js',
          '**/*.config.*.js',
          // leading wildcard to work in CLI (package path) and IDE (repo path)
          '**/test/**',
          // `.test-d.ts` files run under `tsd`; they are test-time
          // artifacts even when colocated with `src/`.
          '**/*.test-d.ts',
          '**/demo*/**/*.{js,mjs,cjs}',
          '**/scripts/**/*.{js,mjs,cjs}',
        ],
      },
    ],

    'import/prefer-default-export': 'off',
  },
};
