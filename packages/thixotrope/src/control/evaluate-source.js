// @ts-check
import harden from '@endo/harden';

/**
 * Transfer source in bounded messages. Ironhorse's current text decoder
 * copies every prefix of a message, so a single message costs the square of
 * its length in scratch heap: at the default 256 MiB chunk ceiling the crank
 * halts a little under sixteen thousand characters. Bootstraps of a few
 * kilobytes go in one message; a bundle, or anything approaching that
 * bound, goes this way.
 *
 * Each concurrent transfer into one vat needs its own staging slot, named by
 * `stage`; two transfers sharing a stage would interleave. A subsequent
 * attempt on a stage replaces an interrupted transfer, whose chunks stay in
 * the vat's heap only until then.
 *
 * @param {{evaluate: (source: string, endowments?: Record<string, unknown>) => Promise<any>}} worker
 * @param {string} source an expression yielding a function of the endowments
 * @param {Record<string, unknown>} endowments
 * @param {{ stage?: 'thixotrope.installSource' | 'thixotrope.mailSource' }} [options]
 *   the staging slot, a name this module's callers agree on rather than
 *   anything user-derived
 */
export const evaluateSource = async (
  worker,
  source,
  endowments,
  { stage = 'thixotrope.installSource' } = {},
) => {
  const slot = `globalThis[Symbol.for(${JSON.stringify(stage)})]`;
  await worker.evaluate(`(${slot} = [], true)`);
  for (let offset = 0; offset < source.length;) {
    let end = Math.min(offset + 1024, source.length);
    const last = source.charCodeAt(end - 1);
    if (end < source.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    // eslint-disable-next-line no-await-in-loop
    await worker.evaluate(`(${slot}.push(chunk), true)`, {
      chunk: source.slice(offset, end),
    });
    offset = end;
  }
  return worker.evaluate(
    `(() => {
    const source = ${slot}.join('');
    delete ${slot};
    return globalThis.eval(source)(endowments);
  })()`,
    { endowments: harden(endowments) },
  );
};
harden(evaluateSource);
