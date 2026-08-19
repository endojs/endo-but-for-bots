// @ts-check

// The filesystem entry. This is the only `@endo/helpdown` module graph that
// imports a node builtin; the package's main entry stays free of them so a
// runtime consumer can import `makeHelp` without dragging `fs` along.

export {
  loadHelpTextFile,
  readHelpTextFileSync,
} from './src/load-help-text.js';
