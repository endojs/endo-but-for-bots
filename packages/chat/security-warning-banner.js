// @ts-check

import harden from '@endo/harden';

// Banner for the startup security warnings the Familiar sends over the
// `familiar:security-warnings` preload channel (see
// designs/familiar-localhttp-protocol.md, "Runtime verification and user
// notification").  The warnings say that a layer of the exfiltration defense
// could not be confirmed; the banner is non-blocking and dismissible.
//
// Call `mount()` after each replacement of `document.body`.  A dismissal lasts
// until the Familiar reports a warning not seen before.  The banner stays above
// the reconnect overlay.

export const SECURITY_WARNING_BANNER_ID = 'familiar-security-warnings';

/**
 * Keep only non-empty strings, without duplicates.  The payload crosses the
 * preload bridge, so its shape is not trusted.
 *
 * @param {unknown} warnings
 * @returns {string[]}
 */
const normalizeWarnings = warnings => {
  if (!Array.isArray(warnings)) {
    return [];
  }
  /** @type {string[]} */
  const kept = [];
  for (const warning of warnings) {
    if (
      typeof warning === 'string' &&
      warning !== '' &&
      !kept.includes(warning)
    ) {
      kept.push(warning);
    }
  }
  return kept;
};

/**
 * @typedef {object} SecurityWarningBanner
 * @property {(next: unknown) => void} show replace the displayed warnings
 * @property {() => void} mount re-insert the banner after a body replacement
 */

/**
 * One banner per page: its dismissal state outlives the body replacements
 * that `mount()` repairs.  The document is a parameter, not the global, so
 * tests can drive the banner against a DOM fixture.
 *
 * @param {Document} document
 * @returns {SecurityWarningBanner}
 */
export const makeSecurityWarningBanner = document => {
  /** @type {string[]} */
  let warnings = [];
  /** Every warning shown so far, so a repeat does not undo a dismissal. */
  /** @type {Set<string>} */
  const seen = new Set();
  let dismissed = false;
  /** @type {HTMLElement | undefined} */
  let element;

  const remove = () => {
    if (element) {
      element.remove();
      element = undefined;
    }
  };

  const render = () => {
    remove();
    if (dismissed || warnings.length === 0 || !document.body) {
      return;
    }
    const banner = document.createElement('div');
    banner.id = SECURITY_WARNING_BANNER_ID;
    banner.setAttribute('role', 'alert');
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 10000;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 8px 12px;
      background: #fff3cd;
      color: #664d03;
      border-bottom: 1px solid #ffda6a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
    `;

    const body = document.createElement('div');
    body.style.flex = '1';
    const title = document.createElement('strong');
    title.textContent = 'Security warning';
    body.appendChild(title);
    const list = document.createElement('ul');
    list.style.margin = '4px 0 0';
    list.style.paddingLeft = '20px';
    for (const warning of warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.appendChild(item);
    }
    body.appendChild(list);
    banner.appendChild(body);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'security-warning-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss security warning');
    dismiss.textContent = '×';
    dismiss.style.cssText = `
      border: none;
      background: transparent;
      color: inherit;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    `;
    dismiss.addEventListener('click', () => {
      dismissed = true;
      remove();
    });
    banner.appendChild(dismiss);

    document.body.prepend(banner);
    element = banner;
  };

  return harden({
    /**
     * Replace the displayed warnings.  An empty or malformed payload clears
     * the banner.
     *
     * @param {unknown} next
     */
    show: next => {
      const normalized = normalizeWarnings(next);
      if (normalized.some(warning => !seen.has(warning))) {
        dismissed = false;
      }
      for (const warning of normalized) {
        seen.add(warning);
      }
      warnings = normalized;
      render();
    },
    /** Re-insert the banner after the page body has been replaced. */
    mount: () => {
      if (!element || !element.isConnected) {
        render();
      }
    },
  });
};
harden(makeSecurityWarningBanner);

/**
 * Subscribe `banner` to the Familiar's security-warning channel.  Outside the
 * Familiar (the Vite dev server, a plain browser) there is no preload bridge
 * and this does nothing.
 *
 * @param {unknown} familiar - `window.familiar`, as exposed by the preload.
 * @param {{ show: (warnings: unknown) => void }} banner
 * @returns {boolean} whether a subscription was made
 */
export const connectSecurityWarnings = (familiar, banner) => {
  const onSecurityWarnings =
    familiar && /** @type {any} */ (familiar).onSecurityWarnings;
  if (typeof onSecurityWarnings !== 'function') {
    return false;
  }
  onSecurityWarnings(warnings => banner.show(warnings));
  return true;
};
harden(connectSecurityWarnings);
