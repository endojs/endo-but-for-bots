// @ts-check
// Helpers for W2.5's integration files (m2-history, m2-archive-restart):
// a scripted backend whose turns are cheap (one round; a tool round every
// tenth turn), turns started with `Session.startTurn` and awaited with
// `Turn.whenFinished` (no Composer receipt, so no receipt bound), the
// history walk from the newest turn back to turn 1 across the vat's pages
// and the agent host's `History`, and the archive directory's files.
/* eslint-disable no-await-in-loop -- turns and pages run in order */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { messageBytes } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** The input that makes a turn take a tool round. */
export const TOOL_INPUT = 'use a tool';

/** One round of text; a tool round then a closing one for TOOL_INPUT. */
export const archiveScript = {
  turns: [
    {
      input: TOOL_INPUT,
      rounds: [
        {
          chunks: [{ text: 'calling a tool ' }],
          toolCalls: [{ name: 'echo', args: JSON.stringify({ text: 'ok' }) }],
          usage,
        },
        { chunks: [{ text: 'done with the tool' }], usage },
      ],
    },
    { rounds: [{ chunks: [{ text: 'a short reply' }], usage }] },
  ],
};

/**
 * Run turn `n` (1-based) of a session: every tenth takes a tool round.
 * Resolves with the turn's handle and its final status.
 * @param {any} session
 * @param {number} n
 */
export const runTurnN = async (session, n) => {
  const text = n % 10 === 0 ? TOOL_INPUT : `message ${n}`;
  const turn = await E(session).startTurn(harden({ text }), Date.now());
  const status = await E(turn).whenFinished();
  return { turn, status };
};

/**
 * The session's archive state as its newest history page reports it.
 * @param {any} session
 */
export const archiveOf = async session => {
  const page = await E(session).getHistoryPage();
  return page.archive;
};

/**
 * History from the newest turn back to turn 1: the session vat's pages for
 * kept turns, then `History.page` for archived ones. Returns the turn ids in
 * the order shown and the size of every page message.
 * @param {any} session
 * @param {any} history the agent host's History (`E(admin).history()`)
 */
export const walkHistory = async (session, history) => {
  /** @type {string[]} */
  const seen = [];
  /** @type {{ where: string, bytes: number, turns: number, records: number }[]} */
  const pages = [];
  /** @type {string | undefined} */
  let cursor;
  let archived = false;
  for (;;) {
    const page = archived
      ? await E(history).page(session, cursor)
      : await E(session).getHistoryPage(cursor);
    pages.push({
      where: archived ? 'archive' : 'vat',
      bytes: messageBytes(page),
      turns: page.turns.length,
      records: page.turns.reduce(
        (/** @type {number} */ n, /** @type {any} */ one) =>
          n + one.records.length,
        0,
      ),
    });
    for (const one of page.turns) seen.push(one.turnId);
    if (page.next === undefined) break;
    if (page.archived) archived = true;
    cursor = page.next;
  }
  return { seen, pages };
};

/**
 * Every file under `<state>/agent-host/archive`, relative.
 * @param {string} root
 */
export const archiveFiles = root => {
  const base = path.join(root, 'agent-host', 'archive');
  if (!existsSync(base)) return [];
  /** @type {string[]} */
  const out = [];
  for (const key of readdirSync(base)) {
    const dir = path.join(base, key);
    for (const name of readdirSync(dir)) out.push(`${key}/${name}`);
  }
  return out.sort();
};

/** The archive root of a state directory. @param {string} root */
export const archiveRoot = root => path.join(root, 'agent-host', 'archive');

/**
 * The `context` lines of a turn's round 0 in a scripted log.
 * @param {any[]} log
 * @param {string} turnId
 */
export const contextOf = (log, turnId) =>
  log.filter(
    (/** @type {any} */ l) =>
      l.kind === 'context' && l.turnId === turnId && l.round === 0,
  );

/** n, n-1, ..., 1 as turn ids. @param {number} n */
export const newestFirst = n =>
  Array.from({ length: n }, (_, i) => `t${n - i}`);
