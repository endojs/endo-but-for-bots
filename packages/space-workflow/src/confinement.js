// @ts-check

/**
 * The confined-renderer allowlists for this space, owned here beside the
 * components whose markup they describe.
 *
 * `renderConfined`'s `allowedTags` REPLACES the default tag set, so this
 * names exactly the tags the workflow space renders — the HTML chrome
 * plus the SVG statechart (the default set admits no SVG at all, which
 * would flatten the chart to bare text). `allowedAttrs` EXTENDS the
 * default attribute set with the SVG geometry attributes the chart
 * needs; none of them are event handlers or injection sinks.
 */

import harden from '@endo/harden';

export const WORKFLOW_SPACE_TAGS = harden([
  // chrome
  'div',
  'nav',
  'main',
  'aside',
  'h3',
  'p',
  'span',
  'ul',
  'ol',
  'li',
  'button',
  'input',
  'pre',
  // statechart
  'svg',
  'g',
  'rect',
  'path',
  'text',
]);

export const WORKFLOW_SPACE_ATTRS = harden([
  'viewbox',
  'role',
  'aria-label',
  'd',
  'x',
  'y',
  'rx',
  'width',
  'height',
  'min',
  'max',
]);
