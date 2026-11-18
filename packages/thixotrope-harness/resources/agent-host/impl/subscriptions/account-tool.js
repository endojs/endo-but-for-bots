// @ts-check
/**
 * The `accountStatus` adapter tool (W4.5; `designs/m4-interfaces.md`
 * section 6, D-M4-9; R3-35, R4-84, R4-86, R4-91): what the model may know
 * about the subscription accounts behind its session's backend, as text in
 * Fae's rendering (`session/account-tool.js`, here `renderAccountStatus` of
 * `accounts.js`). Read-only: no credential, no member object, no reset or
 * redeem authority, no cost, and the session's usage is not attributed to
 * an account.
 *
 * Offered by both pool kinds and both API kinds (`tools: ['accountStatus']`,
 * W4.6); its `adapterTools` entry is `{ name: 'accountStatus', makeTool }`.
 * On a backend that is not a pool it answers `m4Texts.noSubscriptionAccounts`
 * (R4-91). Session usage comes from one `E(session).getUsage()` per call
 * (one session delivery); the accounts are read in process (zero manager
 * deliveries when the pool is registered in this incarnation, else the
 * readers' one `poolState` load). `{ refresh: true }` reads the providers
 * first (R4-85: on demand only).
 *
 * Arguments are the model's JSON text, parsed here, never in a vat (rule
 * 12.10); argument errors are `failed` outcomes with the R4-43 / R4-45
 * texts, as `echo`. A text over `inlineBytes` is staged with a preview (M1b
 * 5.2), as `echo` does.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { interfaces, textOf } from '../../../../guest/lib/interfaces.js';
import {
  boundToolOutput,
  cutText,
  fitsFrame,
  utf8Bytes,
} from '../../../../guest/lib/bounded.js';
import { limits } from '../../../../guest/lib/limits.js';
import { isStaged } from '../../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { renderAccountStatus } from './accounts.js';

const { E, makeExo } = /** @type {any} */ (globalThis);

const TOOL = 'accountStatus';
const ARGUMENT_NAMES = harden(['refresh']);

/**
 * A fixed failure text (harness): the accounts could not be read. Never a
 * provider body or a reason of the provider's choosing.
 */
export const accountStatusFailedText = 'Account status could not be read now';

/** `accountStatus` as offered to the model (a `ToolDescription`). */
export const accountStatusDescription = harden({
  name: TOOL,
  description:
    'Report the subscription accounts behind this session and their quotas: plan, state, rate-limit windows with remaining, percent used and reset time. ' +
    'Every figure says whether it was read from the provider, declared by the operator, or remembered from an earlier reading; pass that on rather than presenting a declared figure as measured. ' +
    'These are configured accounts, not proof of which account paid for previous turns.',
  parameters: JSON.stringify({
    type: 'object',
    properties: {
      refresh: {
        type: 'boolean',
        description:
          'Re-read the provider before answering. Use only when the user asks for current numbers; otherwise the last reading is returned.',
      },
    },
    additionalProperties: false,
  }),
});

/**
 * @param {string} args
 * @returns {string | { refresh: boolean }}
 */
const checkArgs = args => {
  if (args.trim() === '') return { refresh: false };
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch (error) {
    return textOf.argumentsNotJson(
      /** @type {Error} */ (error)?.message ?? String(error),
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return textOf.invalidArgument('args', TOOL, 'a JSON object');
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const unexpected = Object.keys(record).find(
    key => !ARGUMENT_NAMES.includes(key),
  );
  if (unexpected !== undefined)
    return textOf.unexpectedArgument(unexpected, TOOL, ARGUMENT_NAMES);
  const { refresh } = record;
  if (refresh !== undefined && typeof refresh !== 'boolean')
    return textOf.invalidArgument('refresh', TOOL, 'a boolean');
  return { refresh: refresh === true };
};

/** @param {string} message */
const failedOutcome = message => {
  let text = boundToolOutput(message);
  if (!fitsFrame(harden({ status: 'failed', text })))
    text = cutText(text, limits.frameBytes - 1024);
  return harden({ status: 'failed', text });
};

/**
 * @param {import('../blobs.js').BlobStore | undefined} blobs
 * @param {string} text
 */
const okOutcome = async (blobs, text) => {
  if (utf8Bytes(text) <= limits.inlineBytes)
    return harden({ status: 'ok', text });
  try {
    if (blobs === undefined) throw Error('no blob store');
    const staged = await blobs.stage(text, {
      previewUnits: limits.toolPreviewUnits,
    });
    return harden({ status: 'ok', text: staged });
  } catch (error) {
    return failedOutcome(
      textOf.stagingFailed(/** @type {Error} */ (error)?.message ?? `${error}`),
    );
  }
};

/**
 * @param {object} options
 * @param {{ accounts: { accounts: any } }} options.subscriptions this
 *   incarnation's `Subscriptions` (W4.6); only its `accounts` is used
 * @param {any} options.backend the session's `Backend` presence
 * @param {any} [options.session] the `Session` presence (usage)
 * @param {import('../blobs.js').BlobStore} [options.blobs] the session's
 *   blob store (staging)
 */
export const makeAccountStatusTool = ({
  subscriptions,
  backend,
  session,
  blobs,
}) =>
  makeExo('AdapterTool', interfaces.AdapterTool, {
    /** @param {{ opId: string, args: any }} request */
    execute: async ({ args: field }) => {
      /** @type {unknown} */
      let args;
      try {
        args =
          isStaged(field) && blobs !== undefined
            ? await blobs.read(field.blob)
            : field;
      } catch (error) {
        return failedOutcome(
          textOf.stagingFailed(
            /** @type {Error} */ (error)?.message ?? `${error}`,
          ),
        );
      }
      if (typeof args !== 'string')
        return failedOutcome(textOf.stagingFailed('no blob store'));
      const checked = checkArgs(args);
      if (typeof checked === 'string') return failedOutcome(checked);
      const accounts = subscriptions.accounts.accounts;
      /** @type {any} */
      let pool;
      try {
        if (checked.refresh) await accounts.refresh(backend);
        pool = await accounts.forBackend(backend);
      } catch {
        return failedOutcome(accountStatusFailedText);
      }
      /** @type {any} */
      let usage;
      if (session !== undefined) {
        try {
          usage = await E(session).getUsage();
        } catch {
          usage = undefined;
        }
      }
      return okOutcome(blobs, renderAccountStatus(pool, usage));
    },
  });
harden(makeAccountStatusTool);
