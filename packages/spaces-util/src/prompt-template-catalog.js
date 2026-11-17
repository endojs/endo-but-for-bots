// @ts-check

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoHost } from '@endo/daemon' */
/** @import { PromptTemplate, PromptTemplateSource } from '@endo/prompt-templates/types.js' */
/** @import { CommandDefinition } from './command-registry.js' */

import harden from '@endo/harden';

import { E } from '@endo/eventual-send';
import { loadPromptTemplates } from '@endo/prompt-templates/load.js';

import { getCommand } from './command-registry.js';

/**
 * The pet name of the directory holding one read-only tree per template
 * directory, created by `packages/chat/setup-prompt-templates.js`. Its entries
 * sort from lowest to highest precedence.
 */
export const PROMPT_TEMPLATES_PET_NAME = 'prompt-templates';
harden(PROMPT_TEMPLATES_PET_NAME);

/** The command category grouping prompt templates in the command popover. */
export const PROMPT_TEMPLATE_CATEGORY = 'templates';
harden(PROMPT_TEMPLATE_CATEGORY);

/**
 * How many form fields a template takes: one per `argument-hint` token, or one
 * per position up to the highest `$n` when the hint is shorter or absent.
 *
 * @param {PromptTemplate} template
 * @returns {number}
 */
export const countTemplateFields = ({ argumentHint, maxPosition }) =>
  Math.max(argumentHint.length, maxPosition);
harden(countTemplateFields);

/**
 * Present a template as an inline command with one field per position, named
 * `1`, `2`, ..., so the command form prompts for whatever the slash line left
 * out. `argument-hint` supplies the labels and which fields are required;
 * positions beyond the hint are labelled `$n` and optional.
 *
 * @param {PromptTemplate} template
 * @returns {CommandDefinition}
 */
const makeTemplateCommand = template => {
  const { name, description, argumentHint } = template;
  const hintText = argumentHint
    .map(({ label, required }) => (required ? `<${label}>` : `[${label}]`))
    .join(' ');
  return harden({
    name,
    label: name,
    description,
    ...(hintText ? { argumentHint: hintText } : {}),
    category: PROMPT_TEMPLATE_CATEGORY,
    mode: 'inline',
    submitLabel: 'Expand',
    fields: Array.from(
      { length: countTemplateFields(template) },
      (_, index) => {
        const token = argumentHint[index];
        return {
          name: String(index + 1),
          label: token ? token.label : `$${index + 1}`,
          type: /** @type {const} */ ('text'),
          required: token ? token.required : false,
        };
      },
    ),
  });
};

/**
 * The part of a mount the catalog reads.
 *
 * @typedef {object} PromptTemplateTree
 * @property {() => Promise<string[]>} list
 * @property {(entryName: string) => Promise<string>} readText
 */

/**
 * @param {ERef<EndoHost>} powers
 * @returns {Promise<PromptTemplateSource[]>}
 */
const listSources = async powers => {
  await null;
  if (!(await E(powers).has(PROMPT_TEMPLATES_PET_NAME))) {
    return [];
  }
  const directory =
    /** @type {ERef<{ list(): Promise<string[]>, lookup(name: string): Promise<PromptTemplateTree> }>} */ (
      E(powers).lookup(PROMPT_TEMPLATES_PET_NAME)
    );
  const treeNames = await E(directory).list();
  return [...treeNames].sort().map(treeName => {
    const tree = E(directory).lookup(treeName);
    return harden({
      label: treeName,
      list: () => E(tree).list(),
      /** @param {string} entryName */
      readText: entryName => E(tree).readText(entryName),
    });
  });
};

/**
 * Hold the prompt templates the agent has been given and present them as
 * commands. A template never takes the name of a built-in command or alias, so
 * a file in a project directory cannot redefine `/clear` or `/help`.
 *
 * @param {object} options
 * @param {ERef<EndoHost>} options.powers
 * @param {(...messages: unknown[]) => void} [options.warn]
 */
export const makePromptTemplateCatalog = ({ powers, warn = console.warn }) => {
  /** @type {ReadonlyMap<string, PromptTemplate>} */
  let templates = new Map();
  /** @type {ReadonlyMap<string, CommandDefinition>} */
  let commands = new Map();
  let latestRefresh = 0;

  /**
   * Reload from the daemon. Keeps the previous catalog when the reload fails,
   * and ignores the result when a newer reload has started.
   */
  const refresh = async () => {
    latestRefresh += 1;
    const thisRefresh = latestRefresh;
    await null;
    try {
      const loaded = await loadPromptTemplates(await listSources(powers));
      if (thisRefresh !== latestRefresh) {
        return;
      }
      for (const { source, entryName, message } of loaded.diagnostics) {
        warn(
          `Skipped prompt template ${source}/${entryName ?? ''}: ${message}`,
        );
      }
      const available = loaded.templates.filter(({ name, source }) => {
        const reserved = getCommand(name) !== undefined;
        if (reserved) {
          warn(`Skipped prompt template ${source}/${name}.md: reserved name`);
        }
        return !reserved;
      });
      templates = new Map(available.map(template => [template.name, template]));
      commands = new Map(
        available.map(template => [
          template.name,
          makeTemplateCommand(template),
        ]),
      );
    } catch (error) {
      warn('Could not load prompt templates:', error);
    }
  };

  return harden({
    refresh,
    /** @param {string} name */
    getTemplate: name => templates.get(name),
    /** @param {string} name */
    getCommand: name => commands.get(name),
    getCommands: () => harden([...commands.values()]),
  });
};
harden(makePromptTemplateCatalog);
