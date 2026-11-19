// @ts-check
// A `packages` part with the table seam the inbox uses
// (designs/m9-interfaces.md seam S3): `reserve(above?)` raises the counter
// (above `above` when given) and opens nothing; `open({ number, ... })` uses
// the reserved number. Until the session wiring adds both to
// `guest/session/packages.js`, the inbox tests run on this one; it keeps
// the real part's take refusals and its settle and recovery close.
//
// AVA skips files starting with an underscore: a helper, not a test.

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/guards/session.js';
/* eslint-enable import/no-relative-packages */

export const makeInboxPackages = () =>
  harden({
    name: /** @type {const} */ ('packages'),
    make: () => {
      /** @type {Map<number, { values: Map<string, any>, turnId: string }>} */
      const open = new Map();
      let last = 0;
      const table = harden({
        reserve: (above = 0) => {
          last = Math.max(last, above) + 1;
          return last;
        },
        /** @param {{ number?: number, labels: readonly string[], values: Map<string, any>, turnId: string }} pkg */
        open: ({ number, values, turnId }) => {
          const n = number ?? table.reserve();
          open.set(n, { values, turnId });
          return n;
        },
        /**
         * @param {number} number
         * @param {string} edge
         * @param {string} [turnId]
         */
        take: (number, edge, turnId) => {
          const pkg = open.get(number);
          if (pkg === undefined || (turnId && pkg.turnId !== turnId)) {
            throw Error(textOf.noPackage(number));
          }
          if (!pkg.values.has(edge)) throw Error(textOf.noEdge(number, edge));
          return pkg.values.get(edge);
        },
        /** @param {string} turnId */
        closeTurn: turnId => {
          for (const [n, pkg] of open)
            if (pkg.turnId === turnId) open.delete(n);
        },
        size: () => open.size,
      });
      /** @param {{ active: { turnId: string } }} turn */
      const close = ({ active }) => table.closeTurn(active.turnId);
      return harden({
        table,
        hooks: harden({ onSettle: close, onRecover: close }),
      });
    },
  });
