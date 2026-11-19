// @ts-check
// M6 + M8: a real workspace supplies an image to the session's registered tool.
import '../unit/_m1a-prelude.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import test from 'ava';

/* eslint-disable import/no-relative-packages */
import { imageTextOf } from '../../guest/lib/interfaces.js';
import { imageLimits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { environmentsAdminName } from '../../scripts/provision-steps/60-environments.js';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { anthropicEvents } from '../fixtures/fake-provider-server.mjs';
import { openCompactionState, reply } from './_compaction.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  environmentKeys,
  environmentsTemplate,
  startEnvironmentSession,
  toolCall,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'view image in a workspace');
const run = integrationEnabled ? test.serial : test.skip;

/** A one-pixel grayscale PNG padded with a tEXt chunk to the upload limit. */
const workspacePng = () => {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==',
    'base64',
  );
  const padding = Buffer.alloc(imageLimits.maxImageBytes - pixel.length, 0x61);
  padding.writeUInt32BE(padding.length - 12);
  padding.write('tEXtComment\0', 4, 'ascii');
  padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
  return Buffer.concat([pixel.subarray(0, -12), padding, pixel.subarray(-12)]);
};

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
    const { state, slice, server, anthropic, cleanup } =
      await openCompactionState({
        template: environmentsTemplate,
        snapshotEveryDeliveries: 10_000,
      });
    t.teardown(cleanup);
    const tool = toolCall('viewImage', {
      petName: 'workspace',
      path: ['picture.png'],
    });
    server.push(
      { events: anthropicEvents({ toolCalls: [commandCall('true')] }) },
      reply('Workspace open'),
      { events: anthropicEvents({ toolCalls: [tool] }) },
      reply('Image received'),
    );
    const session = await startEnvironmentSession(slice, anthropic);
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    const prepared = await runTurn(slice, session, live, 'open workspace');
    t.is(prepared.end.status, 'completed');
    const keys = environmentKeys(state.root);
    t.is(keys.length, 1);
    const image = workspacePng();
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
    const messages = server
      .requests()
      .filter(req => req.path === '/v1/messages');
    const parts = messages.at(-1)?.json.messages.at(-1)?.content;
    const block = parts?.find(
      (/** @type {any} */ part) => part.type === 'tool_result',
    )?.content[0];
    t.is(block?.type, 'image');
    t.is(block?.source.media_type, 'image/png');
    t.true(Buffer.from(block.source.data, 'base64').equals(image));

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
