// @ts-check
/**
 * The `viewImage` entry of the session's tool table (P-37; R3-30, R4-39;
 * `designs/m8-interfaces.md` 6.1, D-M8-11).
 *
 * The vat reads the model's closed arguments, finds the object the label
 * names in its own label map and hands that object, with the model's raw
 * `path` text, to the agent-host adapter's per-session `ImageTool` (the
 * port tool named `viewImage`). The adapter reads, checks and stages the
 * bytes; the vat sees only the `ToolOutcome`, whose text on success is a
 * StagedText with the receipt as its preview. No byte, mime type or parsed
 * path enters this vat, and the model's JSON is never parsed into a record
 * here (rule 12.10): `path` is passed as the exact source span.
 *
 * Every refusal the vat can make is answered before any send: staged or
 * malformed arguments, an unknown key (the R3-26 text), a petName outside
 * 1-256 units, an unknown label, or a label bound to a stored value rather
 * than an object. An ok outcome tells the `compaction` part that an image
 * was recorded this round (4.1 rule 3: the next round does not ask).
 *
 * `site: 'adapter'`: a retired break from the `ImageTool` is a restart and
 * runs recovery (turn.js `onToolError`), never a failed result.
 *
 * The argument spec lives here, not in `tool-args.js` `argSpecs`: that
 * table is pinned field for field to `toolArgumentNames` of the shared
 * guards, which hold no `viewImage` entry (the names are
 * `viewImageArgumentNames` in `guards/images.js` until the fold).
 *
 * Guest rules.
 */

import { textOf } from '../../lib/guards/session.js';
import {
  imageLimits,
  viewImageDescription,
  viewImageTexts,
} from '../../lib/guards/images.js';
import { labelsOf, readArgs } from './objects.js';

/** @import { ToolTableEntry } from '../tool-table.js' */
/** @import { ArgSpec } from '../../lib/tool-args.js' */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** @param {string} text */
const failed = text => Promise.resolve(harden({ status: 'failed', text }));

/**
 * `petName` a string, `path` any JSON value kept as its source text.
 * @type {ArgSpec}
 */
const spec = harden({
  tool: 'viewImage',
  fields: harden([
    harden({ name: 'petName', kind: 'string', required: true }),
    harden({ name: 'path', kind: 'raw', required: false }),
  ]),
});

/**
 * The `ImageTool` these ports offer, or undefined.
 * @param {any} ports
 */
const imageToolOf = ports =>
  ports?.tools?.find((/** @type {any} */ t) => t.name === 'viewImage')?.tool;

/** @type {ToolTableEntry} */
export const viewImageEntry = harden({
  name: 'viewImage',
  site: 'adapter',
  describe: () => viewImageDescription,
  available: ports => imageToolOf(ports) !== undefined,
  execute: ({ opId, args, turnId }, ports, context) => {
    const read = readArgs('viewImage', args, spec);
    if ('outcome' in read) return Promise.resolve(read.outcome);
    const petName = /** @type {string} */ (read.values.get('petName'));
    const path = read.values.get('path');
    if (petName.length < 1 || petName.length > imageLimits.petNameUnits) {
      return failed(viewImageTexts.badPetName);
    }
    const binding = labelsOf(context).get(petName);
    if (binding === undefined) return failed(textOf.unknownLabel(petName));
    if (binding.kind !== 'object') return failed(viewImageTexts.badPetName);
    return E(imageToolOf(ports))
      .view(
        harden({
          opId,
          target: binding.value,
          ...(path === undefined ? {} : { path }),
        }),
      )
      .then(outcome => {
        if (outcome.status === 'ok') {
          context.runtime.compaction?.imageSeen?.(turnId);
        }
        return outcome;
      });
  },
});
