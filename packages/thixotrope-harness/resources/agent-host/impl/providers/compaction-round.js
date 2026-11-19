// @ts-check
/**
 * The compaction step of a provider round (the M8 contract,
 * `designs/m8-interfaces.md` 5.1; D-M8-1, D-M8-6; P-36; R4-35, R4-36): run
 * by `round.js` `runProviderRound` (step 2b) and by the scripted double
 * (`scripted.js`) after the round's dispatch and before its stream, when
 * the session's `RoundRequest` carries a `compaction` ask.
 *
 * `compactBeforeRound` plans (`compaction.js` `planCompaction` over the
 * context cache's plan input, `planInputOf`), makes the tool-less summary
 * call on the backend's own stream (deltas are not published: the summary
 * is not a reply), checks the summary, stages it when it is over
 * `inlineBytes`, and reports the outcome to the session
 * (`TurnSink.compacted`, answered: crank Y). The session's answer is the
 * cache's next `{ base, append }`; the round is prepared again with it (the
 * cache rebases, no vat page) and streams from the new projection.
 *
 * Outcomes:
 * - `{ projection }`: stream the round from this projection (compacted, or
 *   the old context after a `skipped` the session recorded);
 * - `{ abandon: true }`: the round was stopped, the session answered
 *   `go: false` or broke, or the new prepare was abandoned: send nothing
 *   more (a staged summary not yet named is deleted; one already sent stays
 *   on disk unnamed, M13's sweep);
 * - `{ failed: reason }`: fail the round with this fixed text (a provider
 *   failure of the summary call after its retries, or a staging failure).
 *
 * A plan or summary that cannot help is reported `skipped` with its fixed
 * reason (`compaction.js` `compactionSkipTexts`); the round then runs
 * uncompacted (D-M8-6). Nothing logged quotes a provider body or the
 * summary (R4-79).
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { textOf } from '../../../../guest/lib/interfaces.js';
import { cutText, utf8Bytes } from '../../../../guest/lib/bounded.js';
import { limits, contextLimits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { isAbandoned, planInputOf } from '../context-cache.js';
import {
  checkSummary,
  planCompaction,
  summaryRequest,
  compactionSkipTexts,
} from './compaction.js';

/** @param {unknown} error */
const messageOf = error =>
  /** @type {Error} */ (error)?.message ?? String(error);

/**
 * @param {object} options
 * @param {any} options.req the RoundRequest (carries `compaction`)
 * @param {any} options.projection the round's projection (prepared with
 *   `planInput`)
 * @param {(args: { projection: any, signal: AbortSignal, tools?: readonly any[] }) => AsyncIterable<import('./round.js').RoundEvent>} options.stream
 *   the backend's stream; called with `tools: []` (no tools offered)
 * @param {import('./round.js').RoundControl} options.control
 * @param {((next?: any) => Promise<any>) | undefined} options.prepare the
 *   endpoint's prepare; given the session's next `{ base, append }`
 * @param {import('../blobs.js').BlobStore | undefined} options.blobs
 * @param {any} [options.owner] the Session presence (blob quota)
 * @param {import('./event-log.js').EventLog} options.log
 * @param {() => number} [options.now]
 * @param {string} [options.label] the backend's label: with it the result
 *   carries `servedBy` (the API and pool kinds)
 * @param {string | undefined} options.system the request's system text,
 *   resolved by the caller (`round.js` `systemTextOf`; this module does not
 *   import `round.js`, which imports it)
 * @param {(error: unknown) => string} options.failureOf the fixed text of a
 *   summary stream that failed: a `ProviderFailure`'s reason, else the
 *   backend kind's unexpected-failure text (as `runProviderRound`'s)
 * @returns {Promise<{ projection: any } | { abandon: true } | { failed: string }>}
 */
export const compactBeforeRound = async ({
  req,
  projection,
  stream,
  control,
  prepare,
  blobs,
  owner,
  log,
  now = () => Date.now(),
  label,
  system,
  failureOf,
}) => {
  const { sink, turnId, round } = req;
  const where = { turnId, round };
  const ask = req.compaction;
  /** @type {{ abandon: true }} */
  const abandon = harden({ abandon: true });
  /** @param {any} staged */
  const drop = staged => {
    if (staged !== undefined) void blobs?.drop([staged]).catch(() => 0);
  };

  /**
   * Tell the session (crank Y) and prepare the round again with its answer.
   * @param {Record<string, any>} result a CompactionResult
   * @param {any} [staged] the summary's pending file, named first
   * @returns {Promise<{ projection: any } | { abandon: true } | { failed: string }>}
   */
  const report = async (result, staged) => {
    if (control.stopped() !== undefined) {
      drop(staged);
      return abandon;
    }
    if (staged !== undefined) {
      try {
        await /** @type {any} */ (blobs).commit([staged]);
      } catch (error) {
        drop(staged);
        log('staging-failed', where);
        return harden({ failed: textOf.stagingFailed(messageOf(error)) });
      }
      if (control.stopped() !== undefined) return abandon;
    }
    /** @type {any} */
    let reply;
    try {
      reply = await E(sink).compacted(harden(result));
    } catch {
      // The session is lost or restarted: send nothing more.
      log('compaction-lost', where);
      return abandon;
    }
    if (reply?.go !== true) {
      log('compaction-refused', where);
      return abandon;
    }
    if (control.stopped() !== undefined) return abandon;
    if (prepare === undefined) return harden({ projection });
    try {
      const next = await prepare(
        harden({
          turnId,
          base: reply.base,
          append: reply.append,
          ...(req.context === undefined ? {} : { context: req.context }),
        }),
      );
      if (control.stopped() !== undefined) return abandon;
      return harden({ projection: next });
    } catch (error) {
      if (isAbandoned(error) || control.stopped() !== undefined) {
        log('context-abandoned', where);
        return abandon;
      }
      log('context-failed', where);
      return harden({ failed: textOf.stagingFailed(messageOf(error)) });
    }
  };

  /**
   * @param {string} reason a fixed skip text
   * @param {any} [usage] the summary call's, when it ran
   */
  const skip = (reason, usage) => {
    log('compaction', { ...where, outcome: 'skipped', reason });
    return report({
      round,
      at: now(),
      outcome: 'skipped',
      reason: cutText(reason, limits.reasonUnits),
      ...(usage === undefined ? {} : { usage }),
    });
  };

  // 1-3. The plan and the summary request.
  const input = planInputOf(projection);
  if (input === undefined) return skip(compactionSkipTexts.notCached);
  /** @type {any} */
  let plan;
  /** @type {any} */
  let request;
  try {
    plan = planCompaction({ input, ask, system, tools: req.tools ?? [] });
    request = summaryRequest(plan);
  } catch (error) {
    // A defect of the plan over these records: the round runs uncompacted.
    log('compaction-plan-failed', {
      ...where,
      error: /** @type {any} */ (error)?.name ?? typeof error,
    });
    return skip(compactionSkipTexts.notCached);
  }
  if ('refuse' in request) return skip(request.refuse);

  // 4. The tool-less summary call.
  log('compaction-request', where);
  /** @type {string[]} */
  const parts = [];
  let bytes = 0;
  /** @type {unknown[]} */
  const toolCalls = [];
  /** @type {any} */
  let usage;
  /** @type {{ modelId?: string, provider?: string }} */
  let served = {};
  try {
    for await (const event of stream({
      projection: harden({ transcript: request.transcript }),
      signal: control.signal,
      tools: harden([]),
    })) {
      if (control.stopped() !== undefined) break;
      if ('delta' in event) {
        // Kept until one piece past the bound: enough for `summaryTooLong`.
        if (
          typeof event.delta === 'string' &&
          bytes <= contextLimits.summaryMaxBytes
        ) {
          parts.push(event.delta);
          bytes += utf8Bytes(event.delta);
        }
      } else if ('toolCall' in event) {
        if (toolCalls.length === 0) toolCalls.push(true);
      } else if ('usage' in event) {
        usage = event.usage;
      } else if ('servedBy' in event) {
        served = { ...served, ...event.servedBy };
      }
    }
  } catch (error) {
    if (control.stopped() === undefined) {
      log('compaction-failed', where);
      return harden({ failed: failureOf(error) });
    }
  }
  if (control.stopped() !== undefined) return abandon;

  // 5. The checks.
  const summary = parts.join('');
  const refused = checkSummary({ plan, summary, toolCalls });
  if (refused !== undefined) return skip(refused.refuse, usage);

  // 6. Staged when over inlineBytes (named right before it is sent).
  /** @type {any} */
  let staged;
  if (bytes > limits.inlineBytes) {
    try {
      if (blobs === undefined) throw Error('no blob store');
      staged = await blobs.stagePending(summary, {
        previewUnits: contextLimits.summaryPreviewUnits,
        owner,
      });
    } catch (error) {
      log('staging-failed', where);
      return harden({ failed: textOf.stagingFailed(messageOf(error)) });
    }
  }

  // 7, 8. Crank Y, then the new projection.
  log('compaction', { ...where, outcome: 'done', boundary: plan.boundary });
  const modelId = served.modelId ?? req.options?.modelId;
  return report(
    {
      round,
      at: now(),
      outcome: 'done',
      boundary: plan.boundary,
      summary: staged ?? summary,
      ...(usage === undefined ? {} : { usage }),
      ...(label === undefined || typeof modelId !== 'string' || modelId === ''
        ? {}
        : {
            servedBy: harden({
              label,
              modelId: cutText(modelId, limits.modelIdUnits),
              ...(served.provider === undefined
                ? {}
                : { provider: cutText(served.provider, limits.labelUnits) }),
            }),
          }),
    },
    staged,
  );
};
harden(compactBeforeRound);
