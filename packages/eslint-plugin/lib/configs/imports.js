module.exports = {
  settings: {
    'import/resolver': {
      exports: {},
      node: {},
    },
  },
  rules: {
    // Runtime `import`/`export` extension enforcement, including TypeScript
    // `import type` specifiers (`checkTypeImports`).
    'import/extensions': [
      'error',
      'always',
      { ignorePackages: true, checkTypeImports: true },
    ],
    // JSDoc `@import` tags live in comments, outside `import/extensions`'
    // reach; this rule enforces the same extension discipline on them.
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
