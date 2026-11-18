// @ts-check
/**
 * The gateway's Content-Security-Policy header (M3 W3.1; m3-interfaces.md
 * 4.1; W-15, a departure from R7-47, owner decision 2).
 *
 * The strict `cspDirectives` of the contract plus the sources extensions add
 * (`GatewayExtension.csp`): added, never removed. A source or directive that
 * could break out of the header's grammar (a `;`, `,`, quote misuse or a
 * control character) is refused with an error, so an extension cannot inject
 * a directive of its own.
 *
 * Node only (adapter).
 */
import { cspDirectives } from './contract-m3.js';

const DIRECTIVE = /^[a-z][a-z-]{0,63}$/;
// A CSP source expression: no whitespace, `;` or `,`, at most 512 units.
const SOURCE = /^[\x21-\x2b\x2d-\x3a\x3c-\x7e]{1,512}$/;

/**
 * The header value: every directive of `cspDirectives` in its order, then
 * any directive only an extension names, each with its sources de-duplicated
 * in first-seen order.
 *
 * @param {Record<string, string[]>} [extra] sources added per directive
 * @returns {string}
 */
export const cspHeader = (extra = {}) => {
  /** @type {Map<string, string[]>} */
  const merged = new Map();
  for (const [name, sources] of Object.entries(cspDirectives)) {
    merged.set(name, [...sources]);
  }
  for (const [name, sources] of Object.entries(extra)) {
    if (!DIRECTIVE.test(name)) throw Error(`invalid CSP directive name`);
    if (!Array.isArray(sources)) throw Error(`CSP sources must be an array`);
    const list = merged.get(name) ?? [];
    for (const source of sources) {
      if (typeof source !== 'string' || !SOURCE.test(source)) {
        throw Error(`invalid CSP source for ${name}`);
      }
      if (!list.includes(source)) list.push(source);
    }
    merged.set(name, list);
  }
  const parts = [];
  for (const [name, sources] of merged) {
    // `'none'` alone means none; once an extension adds a source it no longer
    // does, and keeping it would make the directive invalid.
    const kept =
      sources.length > 1 ? sources.filter(s => s !== "'none'") : sources;
    parts.push(`${name} ${kept.join(' ')}`);
  }
  return parts.join('; ');
};
harden(cspHeader);
