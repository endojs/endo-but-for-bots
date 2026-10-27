// @ts-check
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, expect } = require('@playwright/test');

const css = ['chat/index.css', 'space-floot/src/floot.css']
  .map(name => readFileSync(join(__dirname, '../../packages', name), 'utf8'))
  .join('\n');

for (const colorScheme of /** @type {const} */ (['light', 'dark'])) {
  test(`stopping the mic restores inactive colors while still hovered (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.setContent(`
      <div class="floot-app">
        <button class="floot-mic" aria-label="Microphone" aria-pressed="false">🎤</button>
      </div>
    `);
    await page.addStyleTag({ content: css });
    await page.addStyleTag({ content: '.floot-mic { transition: none; }' });
    const mic = page.getByRole('button', { name: 'Microphone' });
    await mic.evaluate(button => {
      button.addEventListener('click', () => {
        const active = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('listening', active);
      });
    });
    const inactive = await mic.evaluate(button => {
      const view = button.ownerDocument.defaultView;
      if (!view) throw Error('Missing browser window');
      const style = view.getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color };
    });
    await mic.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(mic).not.toHaveCSS('color', inactive.color);
    await mic.click();
    await mic.hover();
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await expect(mic).toHaveCSS('color', inactive.color);
    await expect(mic).toHaveCSS('background-color', inactive.background);
  });
}
