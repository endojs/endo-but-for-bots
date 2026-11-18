// @ts-check
/**
 * The session's M5 runtime parts (W5.3; `designs/m5-interfaces.md` 2.8 S4,
 * sections 10 and 11): a hook table, append-only. Each entry is
 *
 *   { name: 'powers' | 'inspector' | 'grants' | 'packages', make(runtime) }
 *
 * and is made once per session, in `makeSession`, in table order; what
 * `make` answers is the runtime's part of that name. Tool entries reach the
 * parts through `ToolContext.runtime` (no imports between units). W5.5
 * appends `powers` and `inspector`, W5.6 `grants`, W5.7 `packages`; M9 an
 * `inbox` part.
 *
 * The runtime is a hardened record:
 *
 *   { labels, services, config, session, powers?, inspector?, grants?,
 *     packages?, part(name) }
 *
 * - `labels`: the session's label map (`labels.js`);
 * - `services`, `config`: the session's `SessionServices` and
 *   `SessionConfig`;
 * - `session`: the session internals a part may need, given by
 *   `makeSession` (`{ core, queue, runner, inCrank, refuseIfDeleting }`);
 * - `powers`, `inspector`, `grants`, `packages`: each part, read when used
 *   (a part made earlier in the table can reach one made later at run
 *   time, as `adoptTool` reaches `grants`). All four are required: a table
 *   without one of them is refused when the runtime is made (HR-SYN-23), so
 *   no tool or method meets a missing part.
 *
 * What `Session.grants()` and `Session.enqueueMessageOnce` forward to:
 * `runtime.grants.facet` (the `SessionGrants` exo) and
 * `runtime.packages.enqueueMessageOnce(submission, requestId, at,
 * attachments)` (run inside the Session method's crank).
 *
 * Guest rules.
 */

import { powersPart } from './powers-source.js';
import { inspectorPart } from './tools/inspection.js';
import { grantsPart } from './tools/granted.js';
import { packagesPart } from './packages.js';

/** @import { Labels } from './labels.js' */

/**
 * @typedef {'powers' | 'inspector' | 'grants' | 'packages' | 'inbox'} PartName
 *
 * @typedef {object} M5Part
 * @property {PartName} name
 * @property {(runtime: Runtime) => any} make
 *
 * @typedef {object} Runtime
 * @property {Labels} labels
 * @property {any} services
 * @property {any} config
 * @property {any} session
 * @property {any} powers
 * @property {any} inspector
 * @property {any} grants
 * @property {any} packages
 * @property {(name: PartName) => any} part
 */

/**
 * The parts every runtime has (`makeRuntime` refuses a table without one).
 * @type {readonly PartName[]}
 */
export const requiredParts = harden([
  'powers',
  'inspector',
  'grants',
  'packages',
]);

/** @type {readonly M5Part[]} */
export const m5Parts = harden([
  powersPart,
  inspectorPart,
  grantsPart,
  packagesPart,
]);

/**
 * @param {object} options
 * @param {Labels} options.labels
 * @param {any} options.services
 * @param {any} options.config
 * @param {any} [options.session]
 * @param {readonly M5Part[]} [options.parts]
 * @returns {Runtime}
 */
export const makeRuntime = ({
  labels,
  services,
  config,
  session = undefined,
  parts = m5Parts,
}) => {
  /** @type {Map<string, any>} */
  const made = new Map();
  /** @type {Runtime} */
  const runtime = harden({
    labels,
    services,
    config,
    session,
    get powers() {
      return made.get('powers');
    },
    get inspector() {
      return made.get('inspector');
    },
    get grants() {
      return made.get('grants');
    },
    get packages() {
      return made.get('packages');
    },
    part: name => made.get(name),
  });
  for (const part of parts) {
    if (made.has(part.name)) throw Error(`two runtime parts ${part.name}`);
    made.set(part.name, part.make(runtime));
  }
  for (const name of requiredParts) {
    if (!made.has(name)) throw Error(`no runtime part ${name}`);
  }
  return runtime;
};
harden(makeRuntime);
