// @ts-check

/**
 * @import {
 *   LoadPromptTemplatesResult,
 *   PromptTemplate,
 *   PromptTemplateDiagnostic,
 *   PromptTemplateSource,
 * } from './types.js'
 */

import harden from '@endo/harden';

import { parsePromptTemplate } from './parse.js';

/** The longest template kept in memory and offered to the editor. */
export const MAX_TEMPLATE_LENGTH = 1024 * 1024;
harden(MAX_TEMPLATE_LENGTH);

const TEMPLATE_FILE_PATTERN = /^(.*)\.md$/;
const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Load the `*.md` entries of each source. A later source overrides an earlier
 * one on the same name, so the caller orders sources from lowest to highest
 * precedence. An unreadable source or file yields a diagnostic and never
 * prevents the others from loading.
 *
 * @param {readonly PromptTemplateSource[]} sources
 * @returns {Promise<LoadPromptTemplatesResult>}
 */
export const loadPromptTemplates = async sources => {
  /** @type {Map<string, PromptTemplate>} */
  const templates = new Map();
  /** @type {PromptTemplateDiagnostic[]} */
  const diagnostics = [];

  const sourceResults = await Promise.all(
    sources.map(async source => {
      const { label } = source;
      /** @type {readonly string[]} */
      let entryNames;
      try {
        entryNames = await source.list();
      } catch (error) {
        diagnostics.push({ source: label, message: String(error) });
        return [];
      }
      const loaded = await Promise.all(
        entryNames.map(async entryName => {
          const fileMatch = entryName.match(TEMPLATE_FILE_PATTERN);
          if (!fileMatch) {
            return undefined;
          }
          const [, name] = fileMatch;
          if (!TEMPLATE_NAME_PATTERN.test(name)) {
            diagnostics.push({
              source: label,
              entryName,
              message: `Template name must match ${TEMPLATE_NAME_PATTERN}`,
            });
            return undefined;
          }
          try {
            const text = await source.readText(entryName);
            if (text.length > MAX_TEMPLATE_LENGTH) {
              diagnostics.push({
                source: label,
                entryName,
                message: `Template exceeds ${MAX_TEMPLATE_LENGTH} characters`,
              });
              return undefined;
            }
            return parsePromptTemplate({ name, text, source: label });
          } catch (error) {
            diagnostics.push({
              source: label,
              entryName,
              message: String(error),
            });
            return undefined;
          }
        }),
      );
      return loaded.filter(template => template !== undefined);
    }),
  );

  for (const sourceTemplates of sourceResults) {
    for (const template of sourceTemplates) {
      templates.set(template.name, template);
    }
  }

  return harden({
    templates: [...templates.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    diagnostics,
  });
};
harden(loadPromptTemplates);
