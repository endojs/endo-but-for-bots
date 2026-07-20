(function polyfill() {
  if (typeof globalThis !== 'undefined') {
    // eslint-disable-next-line no-undef
    globalThis.answerPolyfill = 42;
  } else {
    // @ts-expect-error In a no-globalThis environment `this` is the global
    // object; it has no static type here (demo polyfill, sloppy-mode `this`).
    this.answerPolyfill = 42;
  }
  console.log('answerPolyfill added');
})();
