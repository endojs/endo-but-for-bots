// The package on disk named `eslint-plugin-import` is aliased in the
// repo root `.yarnrc.yml` catalog to the actively-maintained
// `eslint-plugin-import-x` soft fork. ESLint resolves plugins by the
// directory name in `node_modules`, so all `import/*` rule references
// continue to work and are served by the import-x implementation. The
// import-x plugin's bundled `unrs-resolver` natively honours the
// `package.json` `exports` field, so the explicit `import/resolver`
// chain previously needed here is no longer required.
module.exports = {
  rules: {
    'import/extensions': ['error', 'always', { ignorePackages: true }],
    'import/no-extraneous-dependencies': [
      'error',
      {
        devDependencies: [
          '**/*.config.js',
          '**/*.config.*.js',
          // leading wildcard to work in CLI (package path) and IDE (repo path)
          '**/test/**',
          '**/demo*/**/*.js',
          '**/scripts/**/*.js',
        ],
      },
    ],

    'import/prefer-default-export': 'off',
  },
};
