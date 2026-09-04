// @ts-check

// Keep this top-level module as the legacy-resolution path for the public Pi
// extension subpath. Its small bootstrap lets ordinary Pi load Endo libraries
// without imposing SES lockdown on Pi's host realm.
import 'ses';
import '@endo/eventual-send/shim.js';
import selectHarden from '@endo/harden';

if (globalThis.harden === undefined) {
  // Select @endo/harden's portable implementation before installing it on the
  // global that existing Endo source modules consume. This permanently claims
  // Object[Symbol.for('harden')] with the portable, non-lockdown
  // implementation (see packages/harden/README.md "Multiple instances"): it
  // is how @endo/harden's own first-caller-wins contract works, and it is
  // also how a real SES lockdown() senses a conflicting prior claim and
  // fails loudly rather than silently coexisting. If Pi's host process later
  // runs lockdown() (from this module or another Endo-based Pi extension
  // sharing the realm), that call throws instead of installing full SES
  // guarantees; that failure is the intended signal, not a bug in either
  // module, per packages/harden/make-selector.js.
  selectHarden(undefined);
  Object.defineProperty(globalThis, 'harden', {
    value: Object[Symbol.for('harden')],
    configurable: false,
    writable: false,
  });
}

const endoCodeModePiExtension =
  await import('./src/endo-code-mode-pi-extension.js');

export const makeEndoCodeModePiExtension =
  endoCodeModePiExtension.makeEndoCodeModePiExtension;
harden(makeEndoCodeModePiExtension);

export default endoCodeModePiExtension.default;
