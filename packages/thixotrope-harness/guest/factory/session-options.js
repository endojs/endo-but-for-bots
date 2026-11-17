// @ts-check
/**
 * `createSession` option resolvers (M1a W1a.6; hook table,
 * `designs/m1a-interfaces.md` sections 9 and 12).
 *
 * `optionResolvers` is append-only for later milestones: each entry is
 * `(options, resolved, context) -> Promise<void>` and fills `resolved`;
 * they run in order. M1a resolves `{ title, preset, backend, modelId,
 * userInitiated }` and, by asking the objects, `backendTitle` and the
 * preset snapshot. Every refusal happens here, before the factory makes a
 * row or a vat (nothing half-made, R4-6).
 *
 * Guest rules: prelude globals only.
 */
import { shapes, textOf, texts } from '../lib/interfaces.js';
import { promptResolver } from '../session/prompt.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/** R4-6: the title of a session created without one. */
export const DEFAULT_TITLE = 'New chat';
/** M1a: the scripted backend's model id when none is given. */
export const DEFAULT_MODEL_ID = 'scripted';

/** Options the guard admits that M1a refuses (later milestones implement them). */
// M2 W2.6: `systemPrompt` and `spoken` are resolved by `promptResolver`.
const NOT_YET = harden(['networkPolicy', 'reasoningEffort']);

/**
 * @typedef {object} ResolvedOptions
 * @property {string} title
 * @property {any} preset a Preset
 * @property {any} backend a Backend
 * @property {string} modelId
 * @property {boolean} userInitiated
 * @property {string} backendTitle the backend's label (`describe()`)
 * @property {{ label: string }} presetSnapshot `shapes.PresetSnapshot`
 */

/**
 * @typedef {object} OptionsContext
 * @property {any} defaultPreset the built-in `chat-only` preset
 */

/**
 * @callback OptionResolver
 * @param {Record<string, any>} options the guarded `shapes.CreateOptions`
 * @param {Partial<ResolvedOptions>} resolved filled in place
 * @param {OptionsContext} context
 * @returns {Promise<void>}
 */

/** @type {OptionResolver} */
const refuse = async options => {
  // R4-6: `model` is refused whatever its value.
  if ('model' in options) throw Error(texts.modelOption);
  for (const name of NOT_YET) {
    if (name in options) throw Error(textOf.optionNotSupported(name));
  }
};

/** @type {OptionResolver} */
const basics = async (options, resolved, { defaultPreset }) => {
  if (options.backend === undefined) throw Error(texts.noBackend);
  resolved.title = options.title ?? DEFAULT_TITLE;
  resolved.preset = options.preset ?? defaultPreset;
  resolved.backend = options.backend;
  resolved.modelId = options.modelId ?? DEFAULT_MODEL_ID;
  // Section 15: true unless a caller (a subagent, M9) says otherwise.
  resolved.userInitiated = options.userInitiated ?? true;
};

/** @type {OptionResolver} */
const describeObjects = async (_options, resolved) => {
  const [info, snapshot] = await Promise.all([
    E(resolved.backend).describe(),
    E(resolved.preset).snapshot(),
  ]);
  mustMatch(info, shapes.BackendInfo);
  mustMatch(snapshot, shapes.PresetSnapshot);
  resolved.backendTitle = info.label;
  resolved.presetSnapshot = /** @type {{ label: string }} */ (snapshot);
};

/** Hook table (append-only). */
export const optionResolvers = harden([
  refuse,
  basics,
  describeObjects,
  // M2 W2.6: the system prompt (R4-26..R4-28; m2-interfaces.md 10).
  promptResolver,
]);

/**
 * Run every resolver in order.
 * @param {Record<string, any>} options
 * @param {OptionsContext} context
 * @returns {Promise<ResolvedOptions>}
 */
export const resolveCreateOptions = async (options, context) => {
  /** @type {Partial<ResolvedOptions>} */
  const resolved = {};
  for (const resolve of optionResolvers) {
    // eslint-disable-next-line no-await-in-loop
    await resolve(options, resolved, context);
  }
  return /** @type {ResolvedOptions} */ (harden(resolved));
};
harden(resolveCreateOptions);
