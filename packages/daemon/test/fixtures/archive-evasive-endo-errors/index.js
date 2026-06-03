// @ts-nocheck
/* global Far */
// Far comes from the worker compartment's endowments at runtime.

// This fixture retains an explicit import of `@endo/errors`, whose
// source contains a JSDoc `import()` annotation that SES censors at
// archive load time.  Without the worker's evasive-transform load-time
// wrapper, this caplet fails to load with an SES SyntaxError on the
// `@endo/errors` source.  With the transform, the censored shape is
// rewritten before the compartment parses the source and the caplet
// loads normally.
import { q } from '@endo/errors';

export const make = (_powers, _context) => {
  return Far('EndoErrorsFromArchive', {
    /**
     * Quote a value via the censored-source `@endo/errors` package.
     *
     * Asserts that the imported namespace's API is reachable from the
     * worker compartment, which transitively proves that the source
     * survived the evasive transform.
     *
     * @param {unknown} value
     */
    quote(value) {
      return `${q(value)}`;
    },
  });
};
