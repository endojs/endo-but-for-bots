// @ts-nocheck
/* global Far */
// Far comes from the worker compartment's endowments at runtime.
// Do NOT add explicit ES module imports: pulling in @endo/far would also
// pull @endo/errors, whose source contains a dynamic-call expression
// that SES rejects on archive load.

// The line below is a TypeScript JSDoc import() type annotation.  It is
// the cleanest trigger for the SES censorship that the worker's
// evasive-transform load-time wrapper exists to evade.  Without the
// transform, the source's dynamic `import()` is rejected at archive
// import time, and `endo make` fails.  With the transform, the
// dynamic `import()` is rewritten to a non-censored shape and the
// caplet loads normally.
/** @typedef {import('node:fs').Stats} ImportedType */

export const make = (_powers, _context) => {
  return Far('JsdocImportFromArchive', {
    /**
     * Reports a tag so the test can assert that this caplet's source
     * survived the evasive transform and reached the compartment.
     */
    tag() {
      return 'archive-evasive-jsdoc-import-loaded';
    },
  });
};
