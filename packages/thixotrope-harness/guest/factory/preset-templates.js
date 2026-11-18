// @ts-check
/**
 * Preset templates and the providers of their objects (M5 W5.1; hook
 * tables, `designs/m5-interfaces.md` sections 2.1, 4.3 and 11).
 *
 * `templateTable` lists the templates a preset may name (Fae
 * `session/preset-catalog.js` templates at `1315bef86`, without `rsi`,
 * `full-control` and `machine-admin`): each with the objects a preset of
 * that template may select, by kind and label (Fae's `petName`).
 *
 * `objectProviders` is append-only for later milestones (M6: the git
 * workspace and the development environment). Each entry is `{ kind,
 * available(context) -> undefined | reason, build(context) -> Promise<{
 * label, value, services? }> }`. A preset whose selected objects include a
 * kind with no provider, or whose provider answers a reason, is listed with
 * `available: false` and refused at creation (`textOf.presetNeeds(kind)`).
 * M5 registers none, so only presets that select no object are available.
 *
 * `publicInternetProviders` is append-only too (M6/M7): `{ available(context)
 * -> boolean }`. The default preset is `general` once one of them answers
 * true (R3-20: a runner allows public internet), else `chat-only`. Empty in
 * M5 (open decision O-10).
 *
 * Guest rules: plain data and functions; prelude globals only.
 */

/**
 * @typedef {object} TemplateObject
 * @property {string} kind
 * @property {string} label the object's label in the session (Fae `petName`)
 * @property {boolean} required whether a session of this template opens
 *   only with this object
 */

/**
 * @typedef {object} PresetTemplate
 * @property {string} template one of `presetTemplateNames`
 * @property {string} label
 * @property {string} description
 * @property {readonly TemplateObject[]} objects
 * @property {boolean} [allObjects] a preset of this template selects every
 *   one of its objects (Fae: `development`)
 */

/**
 * @typedef {object} ObjectProvider
 * @property {string} kind
 * @property {(context: any) => string | undefined} available
 * @property {(context: any) => Promise<{ label: string, value: any, services?: any }>} build
 */

/**
 * @typedef {object} PublicInternetProvider
 * @property {(context: any) => boolean} available
 */

const workspace = harden({
  kind: 'git-workspace',
  label: 'workspace',
  required: true,
});
const shell = harden({
  kind: 'development-environment',
  label: 'shell',
  required: true,
});

/** @type {readonly PresetTemplate[]} */
export const templateTable = harden([
  {
    template: 'development',
    label: 'Development environment',
    description:
      'A git workspace and isolated POSIX Shell with a persistent home for installed tools. Native storage cleanup is manual on its private admin.',
    objects: [workspace, shell],
    allObjects: true,
  },
  {
    template: 'chat-only',
    label: 'Chat only',
    description: 'Chat without shell internet access or additional objects.',
    objects: [],
  },
  {
    template: 'general',
    label: 'General assistant',
    description:
      'A general assistant with optional workspace and isolated shell.',
    objects: [workspace, shell],
  },
  {
    template: 'new-project',
    label: 'New project',
    description:
      'Start a project with a writable, git-backed workspace ready to populate.',
    objects: [workspace],
  },
]);

/**
 * Hook table (append-only; M6).
 * @type {readonly ObjectProvider[]}
 */
export const objectProviders = harden([]);

/**
 * Hook table (append-only; M6/M7).
 * @type {readonly PublicInternetProvider[]}
 */
export const publicInternetProviders = harden([]);

/**
 * The templates and providers a catalogue reads (tests pass their own).
 * @typedef {object} Templates
 * @property {readonly PresetTemplate[]} table
 * @property {readonly ObjectProvider[]} providers
 * @property {readonly PublicInternetProvider[]} internet
 */

/** @type {Templates} */
export const defaultTemplates = harden({
  table: templateTable,
  providers: objectProviders,
  internet: publicInternetProviders,
});
