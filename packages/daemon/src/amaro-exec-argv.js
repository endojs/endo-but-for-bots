// @ts-check
/* global process */

// Node.js resolves a bare `--import` specifier from the child's working
// directory, so resolve the type-stripping hook from this package instead.
const amaroStripUrl = import.meta.resolve('amaro/strip');
const amaroSpecifiers = ['amaro/strip', amaroStripUrl];

/**
 * Returns the `execArgv` for a forked daemon or worker process: the
 * parent's own flags (the `fork` default) plus the `amaro/strip` hook so
 * that `.ts` sources load, added only if the parent does not already
 * carry it.
 *
 * @returns {string[]}
 */
export const makeAmaroExecArgv = () => {
  const { execArgv } = process;
  const hasAmaro = execArgv.some(
    (arg, index) =>
      amaroSpecifiers.some(specifier => arg === `--import=${specifier}`) ||
      (amaroSpecifiers.includes(arg) && execArgv[index - 1] === '--import'),
  );
  return hasAmaro ? [...execArgv] : [...execArgv, '--import', amaroStripUrl];
};
