// @ts-check
/**
 * The pool provider (M4 W4.6; `designs/m4-interfaces.md` 5.2; R4-24, R4-25,
 * R4-74, R4-75, R4-78, R4-80 (G-07), R4-105; D-M4-4): M2's provider shape
 * (`startRound`, `cancelRound`, `releaseTurn`; the kinds carry `unexpectedFailure`) over
 * M2's `runProviderRound`, with a `stream` that tries the pool's members in
 * the order the pool core chooses (W4.2) on the wire client of the pool's
 * kind (W4.3).
 *
 * One round:
 *
 * - the pool is loaded (`Subscriptions.pool`: one `poolState` per
 *   incarnation); a retired pool fails with `subscriptionTexts.retired` (R4-22: no
 *   fallback), a pool with no active member with `subscriptionTexts.noUsableMember`;
 * - the system text is resolved once, before the member loop, with M2's
 *   `systemTextOf` and passed to the wire builders as a plain string (5.2);
 * - per member, once (R4-25): its credential is read (audited; renewed near
 *   expiry). A failure marks the member unusable and the next one is tried,
 *   except `GENERATION_CONFLICT` (another holder is renewing it now), which
 *   skips it for this round only. The attempt runs inside the kind's
 *   overload retry (R4-75, D-M4-4). Before anything was delivered: an
 *   exhausted 429 marks the member (with the reset its headers named) and
 *   the same request, rebuilt, goes to the next member; a 401 renews the
 *   credential once and retries the same member once, then marks it
 *   unusable; any other failure fails the round. After a delivery every
 *   failure fails the round and nothing is retried (R4-74, R4-78).
 * - success stamps the member as the session's (`served`); when every
 *   member is marked or refused, the round fails "Provider subscriptions
 *   exhausted" with the earliest dated reset (G-07).
 *
 * Every answer's rate-limit reading goes to `Subscriptions.observe`
 * (selection and the accounts view). Cancel aborts the attempt in flight
 * and stops the member loop (R4-7). Nothing here logs a token, a header
 * value or a body: the event log gets fixed texts, codes and counts.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  providerOfKind,
  subscriptionTextOf,
  subscriptionTexts,
} from '../../../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { makeEventLog } from '../providers/event-log.js';
import {
  ProviderFailure,
  runProviderRound,
  systemTextOf,
} from '../providers/round.js';
import { makeProviderShell } from '../providers/shell.js';
import { PREPARE_REQUIRED } from '../providers/api.js';
import { claudeAttempt } from './messages.js';
import { codexAttempt } from './responses.js';
import { withOverloadRetry } from './wire.js';

/** @import { MemberEntry } from './types.js' */

/** The fixed text of a round whose pool stream threw something unexpected. */
const UNEXPECTED = harden({
  claude: subscriptionTexts.claudeInferenceFailed,
  codex: subscriptionTextOf.responsesFailed('stream.unreachable', []),
});

/** @param {unknown} error */
const codeOf = error => {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code)
    ? code
    : 'READ_FAILED';
};

/**
 * Events that put something of the answer into the round: after one of
 * these the round is never handed to another member (R4-25).
 * @param {any} event
 */
const delivers = event =>
  ('delta' in event && event.delta !== '') ||
  'toolCall' in event ||
  'nativeContext' in event;

/**
 * @param {object} options
 * @param {string} options.label the backend's label
 * @param {any} options.spec the `PoolSpec`
 * @param {any} options.backend the pool's `Backend` presence
 * @param {any} options.subscriptions this incarnation's `Subscriptions`
 *   (`subscriptions/index.js`)
 * @param {import('../timers.js').Timers} options.timers
 * @param {import('../providers/event-log.js').EventLog} [options.log]
 * @param {import('../blobs.js').BlobStore} [options.blobs] the adapter's
 *   store; `systemTextOf` reads a staged system text per owner
 * @param {typeof globalThis.fetch} [options.fetch] default the
 *   subscriptions' fetch
 * @param {() => number} [options.now]
 */
export const makePoolProvider = ({
  label,
  spec,
  backend,
  subscriptions,
  timers,
  log = makeEventLog({ label, logPath: spec.logPath }),
  blobs,
  fetch = subscriptions.fetch,
  now = () => Date.now(),
}) => {
  const provider = providerOfKind[spec.kind];
  if (provider === undefined)
    throw Error(`No pool kind ${JSON.stringify(spec.kind)}`);
  const wire = provider === 'claude' ? claudeAttempt : codexAttempt;
  const settings = subscriptions.settings;
  const delaysMs =
    provider === 'claude'
      ? settings.claudeOverloadDelaysMs
      : settings.codexOverloadDelaysMs;
  const unexpected = UNEXPECTED[provider];
  // Made at the pool's first open: the accounts view can describe it now.
  subscriptions.know(backend, spec);

  /**
   * @param {string} kind
   * @param {Record<string, unknown>} fields
   */
  const note = (kind, fields) => {
    try {
      log(kind, fields);
    } catch {
      // The event log's failure is not the round's.
    }
  };

  return makeProviderShell({
    timers,
    // `owner` is the Session presence the round serves.
    runRound: async (req, channel, control, prepare, owner) => {
      // The wire builders read the projection's transcript (5.2).
      if (prepare === undefined) throw Error(PREPARE_REQUIRED);
      const where = { turnId: req.turnId, round: req.round };
      await runProviderRound({
        req,
        channel,
        prepare,
        blobs,
        log,
        owner,
        control,
        timers,
        now,
        label,
        unreachable: unexpected,
        // M8 (S-15): `tools` replaces the request's (the summary call).
        stream: async function* poolStream({ projection, signal, tools }) {
          const pool = await subscriptions.pool(backend, spec);
          if (pool.state === 'retired')
            throw new ProviderFailure(subscriptionTexts.retired);
          if (owner !== undefined)
            subscriptions.accounts.sessionOpened(backend, owner);
          if (!pool.members.some(entry => entry.state === 'active'))
            throw new ProviderFailure(subscriptionTexts.noUsableMember);
          // 5.2: resolved once per round, passed on as plain text.
          const system = await systemTextOf(req.system, blobs, owner);
          const options = req.options ?? {};
          const modelId = options.modelId ?? spec.modelId;
          const maxOutputTokens =
            options.maxOutputTokens ?? spec.maxOutputTokens;
          const request = harden({
            modelId: String(modelId),
            ...(options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: options.reasoningEffort }),
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            ...(system === undefined ? {} : { system }),
            tools: tools ?? req.tools ?? [],
          });
          const core = /** @type {any} */ (pool.core);
          const ticket = core.forSession(owner);

          /**
           * @param {MemberEntry} entry
           * @param {string} code
           */
          const unusable = (entry, code) => {
            ticket.unusable(entry.member);
            subscriptions.accounts.memberState(
              backend,
              entry,
              'unusable',
              code,
            );
            note('member-failed', {
              ...where,
              reason: subscriptionTextOf.memberFailed(entry.label, code),
            });
          };

          /**
           * One member's attempt (with its overload retries and at most
           * one renewal after a 401).
           * @param {MemberEntry} entry
           * @returns {AsyncGenerator<any, 'served' | 'next', undefined>}
           */
          async function* tryMember(entry) {
            const holder = subscriptions.credentialOf(entry, spec);
            /** @type {any} */
            let credential;
            try {
              ({ credential } = await holder.current());
            } catch (error) {
              const code = codeOf(error);
              if (code === 'GENERATION_CONFLICT') {
                // Another holder is renewing it now: skip it this round.
                note('member-skipped', { ...where, code });
                return 'next';
              }
              unusable(entry, code);
              return 'next';
            }
            let renewed = false;
            for (;;) {
              let delivered = false;
              try {
                // One attempt at a time, by design (R4-25).
                // eslint-disable-next-line no-await-in-loop
                for await (const event of withOverloadRetry({
                  attempt: attemptSignal =>
                    wire({
                      credential,
                      projection,
                      request,
                      spec,
                      signal: attemptSignal,
                      ...(fetch === undefined ? {} : { fetch }),
                      onReading: reading =>
                        subscriptions.observe(backend, entry, reading),
                      now,
                    }),
                  delaysMs,
                  timers,
                  signal,
                  onRetry: ({ attempt, waitMs }) =>
                    note('retry', { ...where, attempt, waitMs }),
                })) {
                  if (delivers(event)) delivered = true;
                  yield event;
                }
                ticket.served(entry.member);
                subscriptions.accounts.memberState(backend, entry, 'ok');
                return 'served';
              } catch (error) {
                if (
                  !(error instanceof ProviderFailure) ||
                  delivered ||
                  error.delivered ||
                  signal.aborted
                )
                  throw error;
                const facts = /** @type {any} */ (error);
                if (facts.exhausted !== undefined) {
                  ticket.exhausted(
                    entry.member,
                    facts.exhausted.untilMs ?? null,
                  );
                  note('member-exhausted', { ...where });
                  return 'next';
                }
                if (facts.rejected === undefined) throw error;
                if (renewed) {
                  unusable(entry, 'REJECTED');
                  return 'next';
                }
                renewed = true;
                try {
                  // eslint-disable-next-line no-await-in-loop
                  credential = await holder.renewAfterRejection(credential);
                } catch (renewal) {
                  const code = codeOf(renewal);
                  if (code === 'GENERATION_CONFLICT') return 'next';
                  unusable(entry, code);
                  return 'next';
                }
              }
            }
          }

          for (const entry of ticket.select()) {
            if (signal.aborted) return;
            const outcome = yield* tryMember(entry);
            if (outcome === 'served') return;
          }
          const { earliestDatedBackMs } = ticket.earliestBackMs();
          throw new ProviderFailure(
            earliestDatedBackMs === null
              ? subscriptionTextOf.subscriptionsExhausted()
              : subscriptionTextOf.subscriptionsExhausted(
                  new Date(earliestDatedBackMs).toISOString(),
                ),
          );
        },
      });
    },
  });
};
harden(makePoolProvider);

/**
 * A pool's models are the pool catalogue's (H-4 (g)).
 * @type {import('../providers/kinds.js').BackendKind['catalog']}
 */
const poolCatalog = ({ pools }) => pools;

/** The `backendKinds` entry of `claude-pool` (`providers/kinds.js`). */
export const claudePoolKind = harden({
  kind: 'claude-pool',
  makeProvider: makePoolProvider,
  /** The endpoint's text for a round that threw (R4-79: fixed). */
  unexpectedFailure: UNEXPECTED.claude,
  tools: harden(['accountStatus']),
  catalog: poolCatalog,
});

/** The `backendKinds` entry of `codex-pool` (`providers/kinds.js`). */
export const codexPoolKind = harden({
  kind: 'codex-pool',
  makeProvider: makePoolProvider,
  /** The endpoint's text for a round that threw (R4-79: fixed). */
  unexpectedFailure: UNEXPECTED.codex,
  tools: harden(['accountStatus']),
  catalog: poolCatalog,
});
