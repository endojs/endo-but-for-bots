# Chat browser-test fixtures

Each `*.html` page here mounts one real chat component against mock
powers, so a case in the repository's `browser-test/` Playwright suite
can check behavior that happy-dom cannot reproduce: computed CSS,
layout, and real-browser rendering. The pages need no daemon or
gateway.

`yarn build:browser-fixtures` bundles every page into
`test/browser/dist/`, and `browser-test/server.js` serves that
directory under `/chat-fixtures/`. The Browser Tests workflow runs the
build before Playwright.

To add a case:

1. Add `<feature>.html` and `<feature>.js` here. The script mounts the
   component and sets `document.body.dataset.fixtureReady = 'true'`
   once rendering has settled (or `fixtureError` on failure).
2. Add the page to `input` in `vite.browser-fixtures.config.js`.
3. Add `browser-test/tests/chat-<feature>.spec.js`, which loads
   `http://127.0.0.1:3000/chat-fixtures/<feature>.html`, waits for
   `body[data-fixture-ready]`, and asserts on the rendered DOM.

Keep DOM-structure and logic assertions in the happy-dom tests under
`test/unit/` and `test/component/`; use these fixtures for what only a
browser can show.
