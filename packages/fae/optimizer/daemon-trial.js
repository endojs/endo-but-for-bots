#!/usr/bin/env node
// @ts-check
/* global process, setTimeout */
/* eslint-disable no-await-in-loop */

import '@endo/init/debug.js';

import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '@endo/daemon';

const factorySpecifier = new URL('../agent.js', import.meta.url).href;
const mathSpecifier = new URL('../tools/math.js', import.meta.url).href;
const readFileSpecifier = new URL('../tools/read-file.js', import.meta.url)
  .href;
const timestampSpecifier = new URL('../tools/timestamp.js', import.meta.url)
  .href;

const REPLY_TIMEOUT_MS =
  Number(process.env.FAE_OPTIMIZER_REPLY_TIMEOUT_MS) > 0
    ? Number(process.env.FAE_OPTIMIZER_REPLY_TIMEOUT_MS)
    : 30_000;
const POLL_INTERVAL_MS = 500;

/**
 * @typedef {import('./trace-metric.js').TraceExample & {
 *   prompt: string | string[],
 *   attachments?: Array<{ edgeName?: string, kind?: string }>,
 * }} TrialExample
 *
 * @typedef {{
 *   number: bigint,
 *   type: string,
 *   from: string,
 *   strings?: string[],
 * }} InboxMessage
 */

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object} host
 * @param {(message: InboxMessage) => boolean} predicate
 * @param {number} timeoutMs
 */
const waitForMessage = async (host, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = /** @type {InboxMessage[]} */ (
      await E(host).listMessages()
    );
    const hit = messages.find(predicate);
    if (hit) {
      return hit;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for inbox message`);
};

/** @param {string} filePath */
const offsetOf = async filePath => {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
};

/**
 * @param {string} filePath
 * @param {number} fromOffset
 */
const readSince = async (filePath, fromOffset) => {
  const stat = await fs.stat(filePath);
  if (stat.size <= fromOffset) {
    return '';
  }
  const file = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - fromOffset);
    await file.read(buffer, 0, buffer.length, fromOffset);
    return buffer.toString('utf8');
  } finally {
    await file.close();
  }
};

/**
 * @param {string} workerRoot
 */
const findActiveWorkerLog = async workerRoot => {
  let entries;
  try {
    entries = await fs.readdir(workerRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  /** @type {{ logPath: string, mtimeMs: number }[]} */
  const candidates = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const logPath = path.join(workerRoot, entry.name, 'worker.log');
      const stat = await fs.stat(logPath).catch(() => undefined);
      if (stat) {
        candidates.push({ logPath, mtimeMs: stat.mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.logPath;
};

const requireProviderConfig = () => {
  const { LAL_AUTH_TOKEN, LAL_HOST, LAL_MODEL } = process.env;
  if (!LAL_AUTH_TOKEN || !LAL_HOST || !LAL_MODEL) {
    throw new Error('LAL_AUTH_TOKEN, LAL_HOST, and LAL_MODEL are required');
  }
  return harden({
    host: LAL_HOST,
    model: LAL_MODEL,
    authToken: LAL_AUTH_TOKEN,
  });
};

/**
 * @param {TrialExample} example
 * @param {{
 *   host: any,
 *   cwd: string,
 * }} options
 */
const installExampleTools = async (example, { host, cwd }) => {
  if (
    !(example.attachments || []).some(
      attachment => attachment.edgeName === 'read-file',
    )
  ) {
    return;
  }

  const sentinelName = 'fae-smoke-sentinel.json';
  const sentinelToken = `FAE_SMOKE_${Date.now().toString(36)}`;
  await fs.writeFile(
    path.join(cwd, sentinelName),
    JSON.stringify({ token: sentinelToken }, null, 2),
  );
  await E(host).makeUnconfined('@main', readFileSpecifier, {
    resultName: 'read-file',
    env: harden({ FAE_CWD: cwd }),
  });
};

/**
 * @param {{
 *   example: TrialExample,
 *   adoptionSection: string,
 *   systemPrompt: string,
 * }} input
 */
export const runTrial = async ({ example, systemPrompt }) => {
  const providerConfig = requireProviderConfig();
  const trialRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fae-opt-'));
  const cwd = path.join(trialRoot, 'cwd');
  const statePath = path.join(trialRoot, 'state');
  const runPath = path.join(trialRoot, 'run');
  const cachePath = path.join(trialRoot, 'cache');
  const sockPath =
    process.platform === 'win32'
      ? String.raw`\\?\pipe\endo-fae-optimizer-${Date.now()}.sock`
      : path.join(runPath, 'endo.sock');
  const workerRoot = path.join(statePath, 'worker');
  const daemonConfig = {
    statePath,
    ephemeralStatePath: runPath,
    cachePath,
    sockPath,
    pets: new Map(),
    values: new Map(),
  };

  let cancel;
  let cancelled;
  let host;
  try {
    await Promise.all([
      fs.mkdir(cwd, { recursive: true }),
      fs.mkdir(statePath, { recursive: true }),
      fs.mkdir(runPath, { recursive: true }),
      fs.mkdir(cachePath, { recursive: true }),
    ]);

    process.env.ENDO_ADDR = '127.0.0.1:0';
    await purge(daemonConfig);
    await start(daemonConfig);

    ({ reject: cancel, promise: cancelled } = makePromiseKit());
    const { getBootstrap } = await makeEndoClient(
      'fae-optimizer',
      daemonConfig.sockPath,
      cancelled,
    );
    const bootstrap = getBootstrap();
    host = /** @type {any} */ (E(bootstrap).host());

    await E(host).storeValue(providerConfig, 'default');
    const providerId = /** @type {string} */ (
      await E(host).identify('default')
    );
    await E(host).provideGuest('fae-factory-handle', {
      introducedNames: harden({ '@agent': 'host-agent' }),
      agentName: 'profile-for-fae-factory-handle',
    });
    const factoryPowers = await E(host).lookup(
      'profile-for-fae-factory-handle',
    );
    await E(factoryPowers).storeIdentifier('llm-provider', providerId);
    await E(host).makeUnconfined('@main', factorySpecifier, {
      powersName: 'profile-for-fae-factory-handle',
      resultName: 'fae-factory',
    });
    const factory = await E(host).lookup('fae-factory');

    await E(host).makeUnconfined('@main', mathSpecifier, {
      resultName: 'math-tool',
    });
    await E(host).makeUnconfined('@main', timestampSpecifier, {
      resultName: 'timestamp-tool',
    });
    await installExampleTools(example, { host, cwd });

    await E(factory).createAgent(
      'fae-optimizer-agent',
      harden({ systemPrompt }),
    );

    const baselineLog = await findActiveWorkerLog(workerRoot);
    const baselineOffset = baselineLog ? await offsetOf(baselineLog) : 0;
    const prompts = Array.isArray(example.prompt)
      ? example.prompt
      : [example.prompt];
    /** @type {string[]} */
    const replies = [];
    let timedOut = false;

    for (const [index, prompt] of prompts.entries()) {
      const beforeSend = /** @type {InboxMessage[]} */ (
        await E(host).listMessages()
      );
      const inboxBaseline = beforeSend.length
        ? beforeSend[beforeSend.length - 1].number
        : 0n;
      const attachmentNames =
        index === 0
          ? (example.attachments || [])
              .map(attachment => attachment.edgeName)
              .filter(name => typeof name === 'string')
          : [];
      const strings = Array.from(
        { length: Math.max(1, attachmentNames.length) },
        (_unused, segmentIndex) => (segmentIndex === 0 ? prompt : ''),
      );
      await E(host).send(
        'fae-optimizer-agent',
        strings,
        attachmentNames,
        attachmentNames,
      );
      try {
        const reply = await waitForMessage(
          host,
          message =>
            message.number > inboxBaseline &&
            message.type === 'package' &&
            !(
              Array.isArray(message.strings) &&
              message.strings.join('').includes('Fae agent ready.')
            ),
          REPLY_TIMEOUT_MS,
        );
        replies.push(
          Array.isArray(reply.strings) ? reply.strings.join('') : String(reply),
        );
      } catch {
        timedOut = true;
        break;
      }
    }

    const finalLog = await findActiveWorkerLog(workerRoot);
    const finalOffset =
      finalLog && finalLog === baselineLog ? baselineOffset : 0;
    const workerLog = finalLog ? await readSince(finalLog, finalOffset) : '';
    return harden({
      workerLog,
      replyText: replies.at(-1) || '',
      replies,
      timedOut,
    });
  } finally {
    if (cancel) {
      cancel(Error('optimizer teardown'));
      await Promise.allSettled([cancelled]);
    }
    await stop(daemonConfig).catch(() => undefined);
    delete process.env.ENDO_ADDR;
    if (!process.env.FAE_OPTIMIZER_KEEP) {
      await fs.rm(trialRoot, { recursive: true, force: true });
    }
  }
};
harden(runTrial);

const main = async () => {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath) {
    throw new Error('Usage: daemon-trial.js <input.json> <result.json>');
  }
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const result = await runTrial(input);
  await fs.writeFile(resultPath, JSON.stringify(result));
};

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
