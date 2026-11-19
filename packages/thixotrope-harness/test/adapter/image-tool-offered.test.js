// @ts-check
// `viewImage` on every backend kind's ports (resources/agent-host/impl/
// index.js `adapterTools`; designs/m8-interfaces.md 6.2, seam S-18): an
// open through the ops facet (its guard checks the request and the
// TurnPorts) offers the kind's own adapter tools, then `viewImage`, with no
// description (the session's static entry describes it), one ImageTool per
// session, and the tool answers a `ToolOutcome` (a target that is not an
// image source is refused with a fixed text, never a rejection).
import '../unit/_m1a-prelude.js';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { imageTexts } from '../../guest/lib/image-guards.js';
/* eslint-enable import/no-relative-packages */
import {
  adapterTools,
  makeAgentHostImpl,
} from '../../resources/agent-host/impl/index.js';
import { backendKinds } from '../../resources/agent-host/impl/providers/kinds.js';
import { makeFakeBlobSink } from './_m1b-blobs.js';

const { E, Far } = /** @type {any} */ (globalThis);

const harnessTmp = resolve(
  fileURLToPath(new URL('../../tmp/', import.meta.url)),
);

/**
 * A spec the ops guard admits for `kind`.
 * @param {string} kind
 */
const specOf = kind => {
  if (kind === 'scripted') {
    return harden({ kind, label: 'scripted', script: { turns: [] } });
  }
  if (kind === 'claude-pool' || kind === 'codex-pool') {
    return harden({ kind, label: kind, members: [Far('PoolMember', {})] });
  }
  return harden({ kind, label: kind, keyGrant: Far('ReadGrant', {}) });
};

test('every backend kind offers its own tools, then viewImage, one ImageTool per session', async t => {
  mkdirSync(harnessTmp, { recursive: true });
  const root = mkdtempSync(join(harnessTmp, 'image-tool-offered-'));
  t.teardown(() => rmSync(root, { recursive: true, force: true }));
  const impl = makeAgentHostImpl({
    sink: makeFakeBlobSink().sink,
    blobDir: join(root, 'state', 'agent-host', 'blobs'),
    report: () => {},
  });
  t.true(adapterTools.some(entry => entry.name === 'viewImage'));
  t.is(
    adapterTools.find(entry => entry.name === 'viewImage')?.description,
    undefined,
  );
  t.true(backendKinds.length >= 5);
  for (const kind of backendKinds) {
    const backend = Far('Backend', {});
    const spec = specOf(kind.kind);
    const session = Far('Session', {});
    const ports = impl.ops.open(harden({ backend, spec, session }));
    const names = ports.tools.map((/** @type {any} */ entry) => entry.name);
    t.deepEqual(names, [...kind.tools, 'viewImage'], kind.kind);
    const entry = ports.tools.find(
      (/** @type {any} */ e) => e.name === 'viewImage',
    );
    t.false('description' in entry, kind.kind);
    const again = impl.ops.open(harden({ backend, spec, session }));
    t.is(
      again.tools.find((/** @type {any} */ e) => e.name === 'viewImage').tool,
      entry.tool,
      `${kind.kind}: one tool per session`,
    );
    const other = impl.ops.open(
      harden({ backend, spec, session: Far('Session', {}) }),
    );
    t.not(
      other.tools.find((/** @type {any} */ e) => e.name === 'viewImage').tool,
      entry.tool,
      `${kind.kind}: another session has its own`,
    );
    // eslint-disable-next-line no-await-in-loop
    const outcome = await E(entry.tool).view(
      harden({ opId: 'op1', target: Far('NotAnImage', {}) }),
    );
    t.deepEqual(
      outcome,
      { status: 'failed', text: imageTexts.notReadable },
      kind.kind,
    );
  }
});
