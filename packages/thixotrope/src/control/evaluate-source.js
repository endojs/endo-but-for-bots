// @ts-check
import harden from '@endo/harden';

/**
 * Transfer installation source in bounded messages. Ironhorse's current text
 * decoder allocates intermediate prefixes, so sending a whole bundle can
 * exhaust a crank's heap. The supervisor serializes installations using this
 * one staging slot; a subsequent attempt replaces an interrupted transfer.
 * @param {{evaluate: (source: string, endowments?: Record<string, unknown>) => Promise<any>}} workspace
 * @param {string} source an expression yielding a function of the endowments
 * @param {Record<string, unknown>} endowments
 */
export const evaluateSource = async (workspace, source, endowments) => {
  const slot = "globalThis[Symbol.for('thixotrope.installSource')]";
  await workspace.evaluate(`(${slot} = [], true)`);
  for (let offset = 0; offset < source.length;) {
    let end = Math.min(offset + 1024, source.length);
    const last = source.charCodeAt(end - 1);
    if (end < source.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    // eslint-disable-next-line no-await-in-loop
    await workspace.evaluate(`(${slot}.push(chunk), true)`, {
      chunk: source.slice(offset, end),
    });
    offset = end;
  }
  return workspace.evaluate(
    `(() => {
    const source = ${slot}.join('');
    delete ${slot};
    return globalThis.eval(source)(endowments);
  })()`,
    { endowments: harden(endowments) },
  );
};
harden(evaluateSource);
