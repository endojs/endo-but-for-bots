// @ts-check
// M6 + M8: a real workspace supplies an image to the session's registered tool.
import '../unit/_m1a-prelude.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';
import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import {
  IMAGE_ENVELOPE_PREFIX,
  imageTextOf,
} from '../../guest/lib/interfaces.js';
import { imageLimits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { environmentsAdminName } from '../../scripts/provision-steps/60-environments.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice } from './_m1a-slice.js';
import { readField, runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentKeys,
  environmentsTemplate,
  startEnvironmentSession,
  toolCall,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'view image in a workspace');
const run = integrationEnabled ? test.serial : test.skip;

/** @param {string} root @param {any} before @param {any} after */
const incomingFrames = async (root, before, after) => {
  const journal = await readFile(
    path.join(root, 'workers', before.workerId, 'journal.jsonl'),
    'utf8',
  );
  const [header, ...frames] = journal
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const from = Number(before.journalLength) - Number(header.base);
  const to = Number(after.journalLength) - Number(header.base);
  if (from < 0 || to < from || to > frames.length)
    throw Error(
      `Journal does not cover the image call for ${before.debugLabel}`,
    );
  return frames.slice(from, to).map(frame => Buffer.from(frame.b64, 'base64'));
};

run(
  'viewImage reads a workspace file with bounded frames in the manager and session vats',
  async t => {
    t.timeout(5 * 60_000);
    const state = await startFromTemplate(await environmentsTemplate(), {
      t,
      snapshotEveryDeliveries: 10_000,
    });
    const slice = await makeSlice(state);
    const tool = toolCall('viewImage', {
      petName: 'workspace',
      path: ['picture.png'],
    });
    const { backend } = await slice.makeBackend(
      harden({
        turns: [
          commandTurn('open workspace', [[commandCall('true')]]),
          commandTurn('view workspace image', [[tool]]),
        ],
      }),
    );
    const session = await startEnvironmentSession(slice, backend);
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    const prepared = await runTurn(slice, session, live, 'open workspace');
    t.is(prepared.end.status, 'completed');
    const keys = environmentKeys(state.root);
    t.is(keys.length, 1);
    const image = Buffer.alloc(imageLimits.maxImageBytes, 0x2a);
    image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(
      path.join(
        state.root,
        'environments',
        'sessions',
        keys[0],
        'workspace',
        'picture.png',
      ),
      image,
    );
    const before = await slice.workers();
    const input = 'view workspace image';
    const viewed = await runTurn(slice, session, live, input, 90_000);
    const after = await slice.workers();
    t.is(viewed.end.status, 'completed');
    const [answer] = toolResultsOf(await turnRecords(viewed.turn));
    t.false(answer.failed);
    t.is(answer.result.preview, imageTextOf.receipt('image/png'));
    const text = await readField(await E(slice.admin).content(), answer.result);
    t.true(text.startsWith(IMAGE_ENVELOPE_PREFIX));
    const envelope = JSON.parse(text.slice(IMAGE_ENVELOPE_PREFIX.length));
    t.is(envelope.mimeType, 'image/png');
    t.true(Buffer.from(envelope.data, 'base64').equals(image));

    const managerLabel = `native:${environmentsAdminName}`;
    const relevant = before.filter(
      w =>
        w.debugLabel === managerLabel ||
        /^(spare session \d+|session s\d+)$/.test(w.debugLabel),
    );
    const traffic = await Promise.all(
      relevant.map(async worker => ({
        label: worker.debugLabel,
        frames: await incomingFrames(
          state.root,
          worker,
          after.find(w => w.workerId === worker.workerId),
        ),
      })),
    );
    const manager = traffic.find(w => w.label === managerLabel);
    // Pooled sessions retain the spare's label. The submitted input identifies
    // the session handling this turn, even if another spare is refilling.
    const sessionTraffic = traffic.filter(
      w => w.label !== managerLabel && w.frames.some(f => f.includes(input)),
    );
    t.is(sessionTraffic.length, 1);
    if (!manager || !sessionTraffic[0])
      throw Error('missing image-call worker');
    for (const { label, frames } of [manager, sessionTraffic[0]]) {
      t.true(frames.length > 0, `no frames for ${label}`);
      const maxBytes = Math.max(...frames.map(frame => frame.length));
      t.true(maxBytes < 4096, `largest ${label} frame: ${maxBytes} bytes`);
      t.log({
        label,
        imageBytes: image.length,
        frames: frames.length,
        maxBytes,
      });
    }
  },
);
