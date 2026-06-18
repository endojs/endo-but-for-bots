// Browser fixture: prove monaco-editor runs under SES lockdown with the
// `overrideTaming: 'severe'` level that `@endo/preact-container` requires.
//
// Load order mirrors monaco-wrapper.js exactly: `import 'ses'` installs
// `lockdown`, we freeze the realm, and only THEN dynamic-import monaco, so
// monaco's module body and editor creation run against frozen primordials.

import 'ses';

lockdown({ overrideTaming: 'severe' });

(async () => {
  try {
    // Workers are disabled in chat (getWorker returns null); the resulting
    // "post message to worker" errors are expected and unrelated to lockdown.
    globalThis.MonacoEnvironment = { getWorker: () => null };
    const monaco = await import('monaco-editor');
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });

    const el = document.getElementById('app');
    const editor = monaco.editor.create(el, {
      value: 'const x = 1;\nconsole.log(x);\n',
      language: 'javascript',
      automaticLayout: true,
      minimap: { enabled: false },
    });
    editor.setValue('const y = 2;');
    const roundTrip = editor.getValue();

    const colorized = await monaco.editor.colorize('const z = 3;', 'javascript', {
      tabSize: 2,
    });

    globalThis.monacoLockdownResult = {
      ok: true,
      roundTrip,
      colorizedLen: colorized.length,
      hardenIsFn: typeof globalThis.harden === 'function',
    };
  } catch (e) {
    globalThis.monacoLockdownResult = {
      ok: false,
      error: `${e.name}: ${e.message}`,
      stack: String(e.stack).slice(0, 600),
    };
  }
})();
