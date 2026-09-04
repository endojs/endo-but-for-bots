// @ts-check
/// <reference types="ses"/>

/**
 * @import { Component } from '@earendil-works/pi-tui'
 * @import { Theme, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent'
 * @import { AgentToolResult } from '@earendil-works/pi-agent-core'
 * @import { ImageContent, TextContent } from '@earendil-works/pi-ai'
 * @import { Passable } from '@endo/pass-style'
 */

import { Container, Text, truncateToWidth } from '@earendil-works/pi-tui';
import {
  highlightCode,
  keyHint,
  truncateToVisualLines,
} from '@earendil-works/pi-coding-agent';

import { passableAsJustin } from '@endo/marshal';

// Matches the built-in bash tool's collapsed tail preview
// (`dist/core/tools/bash.js`'s `BASH_PREVIEW_LINES`).
const RESULT_PREVIEW_LINES = 5;

/**
 * @typedef {{
 *   cachedWidth: number | undefined,
 *   cachedLines: string[] | undefined,
 *   cachedSkipped: number | undefined,
 * }} EvaluateResultRenderState
 */

/**
 * Pi's `ToolRenderContext` is not re-exported from the package root, so this
 * mirrors the subset this module reads. `renderCall`/`renderResult` are typed
 * opaquely at the `@endo/agent-tools` boundary (see `adapters/pi.js`), so
 * structural compatibility with Pi's real type is what matters, not a shared
 * type name.
 *
 * @typedef {{
 *   lastComponent: Component | undefined,
 *   state: EvaluateResultRenderState,
 *   isError: boolean,
 * }} EvaluateRenderContext
 */

/**
 * @param {{ source?: unknown }} args
 * @param {Theme} theme
 * @returns {string}
 */
const formatEvaluateCall = (args, theme) => {
  const header = theme.fg('toolTitle', theme.bold('$ evaluate'));
  const source = typeof args?.source === 'string' ? args.source : '';
  if (!source) {
    return header;
  }
  const highlighted = highlightCode(source, 'javascript').join('\n');
  return `${header}\n${highlighted}`;
};

/**
 * Render the evaluate tool call: a bash-style bold header plus the
 * highlighted JS source, so the code that ran stays visible even on error.
 *
 * @param {{ source?: unknown }} args
 * @param {Theme} theme
 * @param {EvaluateRenderContext} context
 * @returns {Component}
 */
export const renderEvaluateCall = (args, theme, context) => {
  const text = /** @type {Text} */ (context.lastComponent ?? new Text());
  text.setText(formatEvaluateCall(args, theme));
  return text;
};
harden(renderEvaluateCall);

/**
 * Render human-readable text for a completion value: plain strings pass
 * through with their real newlines intact; every other plain-data value is
 * pretty-printed with `passableAsJustin` rather than `JSON.stringify`, which
 * would escape newlines and misrender BigInts.
 *
 * @param {unknown} details
 * @returns {string}
 */
const detailsToText = details => {
  if (typeof details === 'string') {
    return details;
  }
  if (details === undefined) {
    return 'undefined';
  }
  return passableAsJustin(/** @type {Passable} */ (harden(details)), true);
};

/**
 * @param {TextContent | ImageContent} part
 * @returns {part is TextContent}
 */
const isTextContent = part => part.type === 'text';

/**
 * @param {AgentToolResult<unknown>['content']} content
 * @returns {string}
 */
const contentToText = content =>
  (content ?? [])
    .filter(isTextContent)
    .map(part => part.text)
    .join('\n');

/**
 * Render the evaluate tool result: on success, the completion value derived
 * from `details` (not the SmallCaps model text); on error, the error message
 * from `content`. Collapsed view shows a bash-style last-lines tail preview
 * with an explicit hidden-line count and expand hint; expanded view shows the
 * full text. Small outputs render in full either way, with no marker.
 *
 * @param {AgentToolResult<unknown>} result
 * @param {ToolRenderResultOptions} options
 * @param {Theme} theme
 * @param {EvaluateRenderContext} context
 * @returns {Component}
 */
export const renderEvaluateResult = (result, options, theme, context) => {
  const { state } = context;
  const bodyText = context.isError
    ? contentToText(result.content)
    : detailsToText(result.details);
  const trimmed = bodyText.trim();
  const component = /** @type {Container} */ (
    context.lastComponent ?? new Container()
  );
  component.clear();
  if (trimmed) {
    const color = context.isError ? 'error' : 'toolOutput';
    const styled = trimmed
      .split('\n')
      .map(line => theme.fg(color, line))
      .join('\n');
    if (options.expanded) {
      component.addChild(new Text(`\n${styled}`, 0, 0));
    } else {
      component.addChild({
        render: width => {
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(
              styled,
              RESULT_PREVIEW_LINES,
              width,
            );
            state.cachedLines = preview.visualLines;
            state.cachedSkipped = preview.skippedCount;
            state.cachedWidth = width;
          }
          const skipped = /** @type {number} */ (state.cachedSkipped ?? 0);
          if (skipped > 0) {
            const hint = `${theme.fg('muted', `... (${skipped} earlier lines,`)} ${keyHint('app.tools.expand', 'to expand')}${theme.fg('muted', ')')}`;
            return [
              '',
              truncateToWidth(hint, width, '...'),
              ...(state.cachedLines ?? []),
            ];
          }
          return ['', ...(state.cachedLines ?? [])];
        },
        invalidate: () => {
          state.cachedWidth = undefined;
          state.cachedLines = undefined;
          state.cachedSkipped = undefined;
        },
      });
    }
  }
  component.invalidate();
  return component;
};
harden(renderEvaluateResult);
